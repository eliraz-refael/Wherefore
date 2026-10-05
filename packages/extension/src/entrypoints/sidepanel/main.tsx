import { RegistryProvider } from "@effect/atom-react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "../../ui/components/App.tsx"
import "../../ui/styles.css"

const container = document.getElementById("root")
if (container === null) throw new Error("side panel: #root is missing from index.html")

createRoot(container).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
)
