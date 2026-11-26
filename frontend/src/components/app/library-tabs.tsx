import { ListMusic, Music2 } from "lucide-react"
import { useSearchParams } from "react-router"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type LibraryTab = "songs" | "setlists"

/** Which half of the Library is shown, kept in the URL (?tab=setlists) like its search and sort. */
export function useLibraryTab(): [LibraryTab, (t: LibraryTab) => void] {
  const [params, setParams] = useSearchParams()
  const tab: LibraryTab = params.get("tab") === "setlists" ? "setlists" : "songs"
  const set = (t: LibraryTab) => setParams(t === "setlists" ? { tab: t } : {}, { replace: true })
  return [tab, set]
}

/** Songs | Setlists at the top of the Library. */
export function LibraryTabs() {
  const [tab, setTab] = useLibraryTab()
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as LibraryTab)}>
      <TabsList variant="pill" aria-label="Library">
        <TabsTrigger value="songs"><Music2 />Songs</TabsTrigger>
        <TabsTrigger value="setlists"><ListMusic />Setlists</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
