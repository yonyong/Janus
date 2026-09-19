import { createContext, useContext } from 'react'

/** 顶栏搜索关键词，供项目/需求列表做本地过滤。 */
export const SearchContext = createContext<{ kw: string; setKw: (v: string) => void }>({
  kw: '',
  setKw: () => {},
})

export const useSearch = () => useContext(SearchContext)
