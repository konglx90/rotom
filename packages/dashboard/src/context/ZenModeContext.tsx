import { createContext, useContext, useState } from 'react'

interface ZenModeContextValue {
  zenMode: boolean
  toggleZenMode: () => void
}

const ZenModeContext = createContext<ZenModeContextValue>({
  zenMode: true,
  toggleZenMode: () => {},
})

export function ZenModeProvider({ children }: { children: React.ReactNode }) {
  const [zenMode, setZenMode] = useState(true)
  const toggleZenMode = () => setZenMode(v => !v)

  return (
    <ZenModeContext.Provider value={{ zenMode, toggleZenMode }}>
      {children}
    </ZenModeContext.Provider>
  )
}

export function useZenMode() {
  return useContext(ZenModeContext)
}
