/// <reference path="./bun-test.d.ts" />
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const source = readFileSync(join(import.meta.dir, "../src/tui.ts"), "utf8")

test("registers route-aware narrow overlay in app slot", () => {
  expect(source).toContain("app()")
  expect(source).toContain("buildFloatingPanel")
  expect(source).toContain("api.route.current")
  expect(source).toContain('position", "absolute"')
  expect(source).toContain("const FLOATING_PANEL_TOP = 2")
  expect(source).toContain("const FLOATING_PANEL_TOAST_TOP = 8")
  expect(source).toContain("const FLOATING_PANEL_RIGHT = 2")
  expect(source).toContain('top", floatingPanelTop()')
  expect(source).toContain('right", FLOATING_PANEL_RIGHT')
  expect(source).toContain('api.event.on("tui.toast.show"')
})

test("keeps sidebar content slot for wide layouts", () => {
  expect(source).toContain("sidebar_content")
  expect(source).toContain("buildSidebarPanel")
})

test("declares both registered slot props in the local slot map", () => {
  const slotMap = source.slice(source.indexOf("type AgentSidebarSlotMap"), source.indexOf("type SessionInfo"))

  expect(slotMap).toContain("app: Record<string, never>")
  expect(slotMap).toContain("sidebar_content: {")
  expect(slotMap.match(/session_id: string/g)?.length).toBe(1)
})

test("does not depend on custom session overlay host slot", () => {
  expect(source).not.toContain("session_overlay_under_toast")
})

test("floating overlay toggles expanded state with local left clicks", () => {
  expect(source).toContain("const [floatingExpanded, setFloatingExpanded] = createSignal(false)")
  expect(source).toContain("expandFloatingPanelOnMouseDown")
  expect(source).toContain("collapseFloatingPanelOnMouseDown")
  expect(source).toContain("setProp(box, \"onMouseDown\", isExpanded ? collapseFloatingPanelOnMouseDown : expandFloatingPanelOnMouseDown)")
  expect(source).toContain("if (event.button !== MouseButton.LEFT) return")
  expect(source).toContain("setFloatingExpanded(true)")
  expect(source).toContain("setFloatingExpanded(false)")
  expect(source).toContain("event.stopPropagation()")
  expect(source).not.toContain("consumeFloatingPanelMouseDown")
  expect(source).not.toContain("closeFloatingExpandedOnEscape")
  expect(source).not.toContain("floatingPanelFocused")
  expect(source).not.toContain("syncFloatingPanelFocus")
  expect(source).not.toContain("resetFloatingPanelFocus")
  expect(source).not.toContain('api.keybind.match("escape", event)')
  expect(source).not.toContain("event.preventDefault()")
  expect(source).not.toContain("onKeyDown")
  expect(source).not.toContain("focusable")
  expect(source).not.toContain("Renderable")
  expect(source).not.toContain("KeyEvent")
})

test("expanded floating overlay renders agents and todo item lines", () => {
  const expanded = source.slice(source.indexOf("function renderFloatingExpandedChildren"), source.indexOf("function floatingPanelInnerWidth"))

  expect(expanded).toContain("Agents Detail")
  expect(expanded).toContain("Click to close")
  expect(expanded).toContain('rows.push(renderFloatingLine("Agents", innerWidth))')
  expect(expanded).toContain('rows.push(renderFloatingLine("Todos", innerWidth))')
  expect(expanded).toContain("renderFloatingTodoRows")
  expect(expanded).toContain("limitFloatingAgentRows")
  expect(expanded).toContain("limitFloatingTodoRows")
  expect(expanded).not.toContain("Session:")
  expect(expanded).not.toContain("formatFloatingActivity")
})
