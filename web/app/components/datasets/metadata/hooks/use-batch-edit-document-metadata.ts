import type {
  MetadataBatchEditToServer,
  MetadataItemInBatchEdit,
  MetadataItemWithEdit,
  MetadataItemWithValue,
} from '../types'
import type { SimpleDocumentDetail } from '@/models/datasets'
import { useBoolean } from 'ahooks'
import { t } from 'i18next'
import { useMemo } from 'react'
import { toast } from '@/app/notifications'
import {
  useBatchUpdateDocMetadata,
  useDocumentMetaDataList,
} from '@/service/knowledge/use-metadata'
import { UpdateType } from '../types'

type Props = Readonly<{
  datasetId: string
  docList: SimpleDocumentDetail[]
  selectedDocumentIds?: string[]
  onUpdate: () => void
}>
const useBatchEditDocumentMetadata = ({
  datasetId,
  docList,
  selectedDocumentIds,
  onUpdate,
}: Props) => {
  const [isShowEditModal, { setTrue: setShowEditModal, setFalse: hideEditModal }] =
    useBoolean(false)
  const documentIds = selectedDocumentIds || docList.map((doc) => doc.id)
  const offPageDocumentIds = useMemo(
    () => documentIds.filter((documentId) => !docList.some((doc) => doc.id === documentId)),
    [docList, documentIds],
  )
  const offPageDocumentQueries = useDocumentMetaDataList({
    datasetId,
    documentIds: offPageDocumentIds,
  })
  const metaDataList: MetadataItemWithValue[][] = useMemo(() => {
    const metadataByDocumentId = new Map(
      docList.map((doc) => [doc.id, doc.doc_metadata ?? []] as const),
    )
    offPageDocumentQueries.forEach((query, index) => {
      if (query.data)
        metadataByDocumentId.set(offPageDocumentIds[index]!, query.data.doc_metadata ?? [])
    })
    return documentIds.map((documentId) =>
      (metadataByDocumentId.get(documentId) ?? []).filter((item) => item.id !== 'built-in'),
    )
  }, [docList, documentIds, offPageDocumentIds, offPageDocumentQueries])
  const metadataByDocumentId = useMemo(
    () => new Map(documentIds.map((documentId, index) => [documentId, metaDataList[index] ?? []])),
    [documentIds, metaDataList],
  )
  // To check is key has multiple value
  const originalList: MetadataItemInBatchEdit[] = useMemo(() => {
    const idNameValue: Record<
      string,
      {
        value: string | number | null
        isMultipleValue: boolean
      }
    > = {}
    const documentCountById: Record<string, number> = {}
    const res: MetadataItemInBatchEdit[] = []
    metaDataList.forEach((metaData) => {
      metaData.forEach((item) => {
        if (idNameValue[item.id]?.isMultipleValue) return
        const itemInRes = res.find((i) => i.id === item.id)
        if (!idNameValue[item.id]) {
          idNameValue[item.id] = {
            value: item.value,
            isMultipleValue: false,
          }
        }
        if (itemInRes && itemInRes.value !== item.value) {
          idNameValue[item.id]!.isMultipleValue = true
          itemInRes.isMultipleValue = true
          itemInRes.value = null
          return
        }
        if (!itemInRes) {
          res.push({
            ...item,
            isMultipleValue: false,
          })
          documentCountById[item.id] = 1
          return
        }
        documentCountById[item.id] = (documentCountById[item.id] ?? 0) + 1
      })
    })
    res.forEach((item) => {
      if ((documentCountById[item.id] ?? 0) < metaDataList.length) {
        item.isMultipleValue = true
        item.value = null
      }
    })
    return res
  }, [metaDataList])
  const toCleanMetadataItem = (
    item: MetadataItemWithValue | MetadataItemWithEdit | MetadataItemInBatchEdit,
  ): MetadataItemWithValue => ({
    id: item.id,
    name: item.name,
    type: item.type,
    value: item.value ?? null,
  })
  const formateToBackendList = (
    editedList: MetadataItemWithEdit[],
    addedList: MetadataItemInBatchEdit[],
    isApplyToAllSelectDocument: boolean,
  ) => {
    const updatedList = editedList.filter((editedItem) => {
      return editedItem.updateType === UpdateType.changeValue
    })
    const removedList = originalList.filter((originalItem) => {
      const editedItem = editedList.find((i) => i.id === originalItem.id)
      if (!editedItem)
        // removed item
        return true
      return false
    })
    const res: MetadataBatchEditToServer = documentIds.map((documentId) => {
      const docIndex = docList.findIndex((doc) => doc.id === documentId)
      const oldMetadataList = metadataByDocumentId.get(documentId) ?? []
      let newMetadataList: MetadataItemWithValue[] = [...(oldMetadataList ?? []), ...addedList]
        .filter((item) => {
          return !removedList.find((removedItem) => removedItem.id === item.id)
        })
        .map(toCleanMetadataItem)
      if (isApplyToAllSelectDocument) {
        // add missing metadata item
        updatedList.forEach((editedItem) => {
          if (!newMetadataList.find((i) => i.id === editedItem.id) && !editedItem.isMultipleValue)
            newMetadataList.push(toCleanMetadataItem(editedItem))
        })
      }
      newMetadataList = newMetadataList.map((item) => {
        const editedItem = updatedList.find((i) => i.id === item.id)
        if (editedItem) return toCleanMetadataItem(editedItem)
        return item
      })
      return {
        document_id: documentId,
        metadata_list: newMetadataList,
        metadata_ids_to_remove: removedList.map((item) => item.id),
        partial_update: docIndex < 0,
      }
    })
    return res
  }
  const { mutateAsync } = useBatchUpdateDocMetadata()
  const showEditModal = async () => {
    const queryResults = await Promise.all(
      offPageDocumentQueries.map((query) =>
        query.isSuccess ? Promise.resolve(query) : query.refetch(),
      ),
    )
    if (queryResults.every((query) => query.isSuccess)) setShowEditModal()
  }
  const handleSave = async (
    editedList: MetadataItemWithEdit[],
    addedList: MetadataItemInBatchEdit[],
    isApplyToAllSelectDocument: boolean,
  ) => {
    const backendList = formateToBackendList(editedList, addedList, isApplyToAllSelectDocument)
    await mutateAsync({
      dataset_id: datasetId,
      metadata_list: backendList,
    })
    onUpdate()
    hideEditModal()
    toast.success(t(($) => $['actionMsg.modifiedSuccessfully'], { ns: 'common' }))
  }
  return {
    isShowEditModal,
    showEditModal,
    hideEditModal,
    originalList,
    handleSave,
  }
}
export default useBatchEditDocumentMetadata
