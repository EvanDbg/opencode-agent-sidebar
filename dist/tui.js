import { MouseButton } from "@opentui/core";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createUpdateNotifier } from "./update-notifier.js";
const PLUGIN_ID = "subagent-sidebar";
const PLUGIN_VERSION = "0.2.4";
const SIDEBAR_ORDER = 200;
const SIDEBAR_AUTO_WIDE_WIDTH = 120;
const FLOATING_PANEL_TOP = 2;
const FLOATING_PANEL_TOAST_TOP = 8;
const FLOATING_PANEL_RIGHT = 2;
const FLOATING_PANEL_MAX_WIDTH = 44;
const FLOATING_EXPANDED_PANEL_MAX_WIDTH = 72;
const FLOATING_EXPANDED_PANEL_MAX_HEIGHT = 22;
const FLOATING_PANEL_BORDER_ROWS = 2;
const DEFAULT_TOAST_DURATION_MS = 5_000;
const TICK_INTERVAL_MS = 1000;
const COMPLETION_RETENTION_MS = 3_000;
const QUEUED_STALE_MS = 60_000;
const DESCRIPTION_MAX_LEN = 26;
const COLLAPSED_KV_KEY = "agents-panel.collapsed";
const MAIN_AGENT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BG_STATUS_PATTERN = /\[BACKGROUND TASK (COMPLETED|ERROR|TIMEOUT|CANCELLED|RETRYING)\]/;
const BG_ID_IN_TEXT_PATTERN = /\*\*ID:\*\*\s*`?(bg_[A-Za-z0-9]+)`?/;
const BG_ID_IN_OUTPUT_PATTERN = /Background Task ID:\s*(bg_[A-Za-z0-9]+)/;
const BG_ID_IN_METADATA_BLOCK_PATTERN = /background_task_id:\s*(bg_[A-Za-z0-9]+)/;
const DELEGATION_STARTED_PATTERN = /Delegation started:\s*([^\s]+)/;
const TASK_SUMMARY_LINE_PATTERN = /-\s+`(bg_[A-Za-z0-9]+)`:\s*([^\n]+)/g;
function readString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function extractBgIDFromText(haystack) {
    const meta = BG_ID_IN_METADATA_BLOCK_PATTERN.exec(haystack);
    if (meta)
        return meta[1];
    const launched = BG_ID_IN_OUTPUT_PATTERN.exec(haystack);
    if (launched)
        return launched[1];
    const fallback = BG_ID_IN_TEXT_PATTERN.exec(haystack);
    return fallback?.[1];
}
function extractDelegationIDFromText(haystack) {
    return DELEGATION_STARTED_PATTERN.exec(haystack)?.[1];
}
function resolveAgentName(input, metadata) {
    return readString(input.subagent_type) ?? readString(input.agent) ?? readString(metadata.agent) ?? "agent";
}
function resolveDescription(input, metadata) {
    return readString(input.description) ?? readString(metadata.description) ?? "";
}
function makeKey(kind, id) {
    return `${kind}:${id}`;
}
function resolveStartedAt(part, fallbackStartedAt, now) {
    const timestamp = part.state?.time?.start ?? part.time?.start ?? part.time?.created ?? fallbackStartedAt;
    if (timestamp !== undefined)
        return { value: timestamp, hasTimestamp: true };
    return { value: now, hasTimestamp: false };
}
function isStaleQueued(startedAt, now) {
    return now - startedAt > QUEUED_STALE_MS;
}
const tui = async (api) => {
    const active = new Map();
    const [now, setNow] = createSignal(Date.now());
    const [version, setVersion] = createSignal(0);
    const [collapsed, setCollapsed] = createSignal(api.kv.get(COLLAPSED_KV_KEY, false));
    const [updateStatus, setUpdateStatus] = createSignal(null);
    const [floatingPanelTop, setFloatingPanelTop] = createSignal(FLOATING_PANEL_TOP);
    const [floatingExpanded, setFloatingExpanded] = createSignal(false);
    let toastTimer;
    const bumpVersion = () => {
        setVersion((value) => value + 1);
    };
    const updateNotifier = createUpdateNotifier(api, PLUGIN_VERSION, setUpdateStatus);
    const toggleCollapsed = () => {
        const next = !collapsed();
        setCollapsed(next);
        api.kv.set(COLLAPSED_KV_KEY, next);
    };
    const unregisterCommand = api.command.register(() => [
        {
            title: collapsed() ? "Expand Agents Panel" : "Collapse Agents Panel",
            value: "subagent-sidebar.toggle",
            description: "Toggle the Agents section in the sidebar",
            category: "Plugin",
            keybind: "ctrl+x a",
            slash: { name: "agents-toggle" },
            onSelect: toggleCollapsed,
        },
    ]);
    const touchEntry = (entry, agent, description) => {
        let mutated = false;
        if (description.length > 0 && entry.description !== description) {
            entry.description = description;
            mutated = true;
        }
        if (agent !== "agent" && entry.agent !== agent) {
            entry.agent = agent;
            mutated = true;
        }
        return mutated;
    };
    const completeEntry = (entry, status, completedAt) => {
        const nextStatus = status === "error" ? "error" : "completed";
        const statusChanged = entry.status !== nextStatus;
        // Stamp completedAt only on the first transition to a terminal state.
        // Re-stamping (e.g. when scanSessionState re-matches the same
        // [ALL BACKGROUND TASKS COMPLETE] system reminder on every 1s tick) would
        // make the elapsed timer keep climbing past completion, so a "Done" entry
        // visually behaves like it's still running.
        const stampChanged = entry.completedAt === undefined;
        if (stampChanged)
            entry.completedAt = completedAt;
        if (statusChanged)
            entry.status = nextStatus;
        return statusChanged || stampChanged;
    };
    const syncLiveToolEntry = (entry, agent, description, status) => {
        let mutated = touchEntry(entry, agent, description);
        if (entry.status !== status) {
            entry.status = status;
            mutated = true;
        }
        return mutated;
    };
    const promoteCallIDToBgID = (callID, bgID) => {
        const callKey = makeKey("background", callID);
        const staleForegroundKey = makeKey("foreground", callID);
        const bgKey = makeKey("background", bgID);
        const entry = active.get(callKey);
        active.delete(staleForegroundKey);
        if (!entry)
            return false;
        if (active.has(bgKey)) {
            active.delete(callKey);
            return true;
        }
        active.delete(callKey);
        entry.key = bgKey;
        entry.bgID = bgID;
        entry.callID = callID;
        active.set(bgKey, entry);
        return true;
    };
    const pruneMainEntries = (sessionID, keepKey) => {
        let mutated = false;
        for (const [key, entry] of active) {
            if (entry.sessionID === sessionID && entry.kind === "main" && key !== keepKey) {
                active.delete(key);
                mutated = true;
            }
        }
        return mutated;
    };
    const upsertMainMessage = (sessionID, message) => {
        if (message.role !== "assistant" || !message.id || !message.agent)
            return false;
        const key = makeKey("main", message.id);
        let mutated = pruneMainEntries(sessionID, key);
        const startedAt = message.time?.created ?? Date.now();
        const completedAt = message.time?.completed;
        const status = message.error ? "error" : completedAt ? "completed" : "running";
        if (completedAt && isExpired(completedAt, Date.now()))
            return active.delete(key) || mutated;
        const existing = active.get(key);
        if (!existing) {
            active.set(key, {
                key,
                sessionID,
                kind: "main",
                agent: message.agent,
                description: message.mode ?? "main",
                status,
                startedAt,
                completedAt,
            });
            return true;
        }
        mutated = touchEntry(existing, message.agent, message.mode ?? "main") || mutated;
        if (completedAt && existing.completedAt !== completedAt)
            mutated = completeEntry(existing, status, completedAt) || mutated;
        if (!completedAt && existing.status !== status) {
            existing.status = status;
            mutated = true;
        }
        return mutated;
    };
    const upsertSubtaskPart = (sessionID, part) => {
        if (part.type !== "subtask")
            return false;
        const partID = part.id;
        if (!partID)
            return false;
        const key = makeKey("foreground", partID);
        const agent = readString(part.agent) ?? "agent";
        const description = readString(part.description) ?? "subtask";
        const existing = active.get(key);
        if (existing)
            return touchEntry(existing, agent, description);
        active.set(key, {
            key,
            sessionID,
            kind: "foreground",
            agent,
            description,
            status: "running",
            startedAt: part.time?.start ?? Date.now(),
        });
        return true;
    };
    const upsertAgentPart = (sessionID, part) => {
        if (part.type !== "agent")
            return false;
        const partID = part.id;
        const agent = readString(part.name);
        if (!partID || !agent)
            return false;
        const key = makeKey("foreground", partID);
        const existing = active.get(key);
        if (existing)
            return touchEntry(existing, agent, "agent part");
        active.set(key, {
            key,
            sessionID,
            kind: "foreground",
            agent,
            description: "agent part",
            status: "running",
            startedAt: part.time?.start ?? Date.now(),
        });
        return true;
    };
    const upsertToolPart = (sessionID, part, options = {}) => {
        if (part.type !== "tool")
            return false;
        if (part.tool !== "task" && part.tool !== "delegate")
            return false;
        const callID = part.callID ?? part.id;
        if (!callID)
            return false;
        const status = part.state?.status;
        const input = (part.state?.input ?? {});
        const metadata = (part.state?.metadata ?? {});
        const output = part.state?.output ?? "";
        const isBackground = input.run_in_background === true || part.tool === "delegate";
        const kind = isBackground ? "background" : "foreground";
        const key = makeKey(kind, callID);
        const agent = resolveAgentName(input, metadata);
        const description = resolveDescription(input, metadata);
        const current = options.now ?? Date.now();
        const startedAt = resolveStartedAt(part, options.fallbackStartedAt, current);
        if (status === "pending" || status === "running") {
            const existing = active.get(key);
            if (status === "pending" && options.source === "scan") {
                if (!startedAt.hasTimestamp && !existing)
                    return false;
                if (startedAt.hasTimestamp && isStaleQueued(startedAt.value, current)) {
                    return existing?.status === "queued" || !existing ? active.delete(key) : false;
                }
            }
            if (existing && status === "running")
                return syncLiveToolEntry(existing, agent, description, "running");
            if (existing?.status === "queued" && isStaleQueued(existing.startedAt, current))
                return active.delete(key);
            if (existing)
                return syncLiveToolEntry(existing, agent, description, "queued");
            active.set(key, {
                key,
                sessionID,
                kind,
                agent,
                description,
                status: status === "pending" ? "queued" : "running",
                startedAt: startedAt.value,
                callID,
            });
            return true;
        }
        if (status === "completed") {
            if (isBackground) {
                const bgID = readString(metadata.backgroundTaskId) ?? extractBgIDFromText(output) ?? extractDelegationIDFromText(output);
                active.delete(makeKey("foreground", callID));
                if (!bgID)
                    return active.delete(key);
                const existing = active.get(key);
                if (existing) {
                    touchEntry(existing, agent, description);
                    return promoteCallIDToBgID(callID, bgID);
                }
                const bgKey = makeKey("background", bgID);
                const promoted = active.get(bgKey);
                if (promoted)
                    return touchEntry(promoted, agent, description);
                // Live launches always pass through pending/running before reaching
                // completed, so observing status="completed" with no in-flight entry
                // means scanSessionState is replaying a historical message. Resurrecting
                // here would stamp startedAt to part.time.start (potentially hours old)
                // and let handleBackgroundStatusText finalize completedAt = Date.now()
                // on the next tick, producing a spurious "Done 1230m" row before
                // retention prunes it.
                return false;
            }
            const existing = active.get(key);
            if (!existing)
                return false;
            return completeEntry(existing, "completed", part.state?.time?.end ?? Date.now());
        }
        if (status === "error") {
            const existing = active.get(key);
            if (!existing)
                return false;
            return completeEntry(existing, "error", part.state?.time?.end ?? Date.now());
        }
        return false;
    };
    const handleBackgroundStatusText = (part, completedAt) => {
        if (part.type !== "text")
            return false;
        const body = part.text ?? "";
        if (body.length === 0)
            return false;
        const statusMatch = BG_STATUS_PATTERN.exec(body);
        const singleID = BG_ID_IN_TEXT_PATTERN.exec(body)?.[1];
        let mutated = false;
        if (statusMatch && singleID) {
            const entry = active.get(makeKey("background", singleID));
            if (entry) {
                const statusText = statusMatch[1];
                if (statusText === "COMPLETED")
                    mutated = completeEntry(entry, "completed", completedAt) || mutated;
                if (statusText === "ERROR" || statusText === "TIMEOUT" || statusText === "CANCELLED") {
                    mutated = completeEntry(entry, "error", completedAt) || mutated;
                }
            }
        }
        if (body.includes("[ALL BACKGROUND TASKS COMPLETE") || body.includes("[ALL BACKGROUND TASKS FINISHED")) {
            const matches = body.matchAll(TASK_SUMMARY_LINE_PATTERN);
            for (const match of matches) {
                const bgID = match[1];
                const description = match[2] ?? "";
                const key = makeKey("background", bgID);
                const existing = active.get(key);
                if (existing) {
                    if (description.length > 0)
                        mutated = touchEntry(existing, existing.agent, description) || mutated;
                    mutated = completeEntry(existing, "completed", completedAt) || mutated;
                }
                // No in-flight entry: same reasoning as upsertToolPart's completed
                // branch — fabricating a row from a system reminder match alone
                // means we're staring at historical message text. Don't resurrect.
            }
        }
        return mutated;
    };
    const scanSessionState = (sessionID) => {
        let mutated = false;
        const current = Date.now();
        const messages = api.state.session.messages(sessionID);
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant)
            mutated = upsertMainMessage(sessionID, lastAssistant) || mutated;
        for (const message of messages) {
            if (!message.id)
                continue;
            const parts = api.state.part(message.id);
            for (const part of parts) {
                mutated =
                    upsertToolPart(sessionID, part, { source: "scan", now: current, fallbackStartedAt: message.time?.created }) || mutated;
                mutated = upsertSubtaskPart(sessionID, part) || mutated;
                mutated = upsertAgentPart(sessionID, part) || mutated;
                // system-reminder parts lack time fields; mirror handlePart fallback so BG completion isn't dropped on rescan.
                const completedAt = part.time?.end ?? part.time?.start ?? current;
                mutated = handleBackgroundStatusText(part, completedAt) || mutated;
            }
        }
        return mutated;
    };
    const handlePart = (sessionID, part) => {
        const current = Date.now();
        const mutated = upsertToolPart(sessionID, part, { source: "live", now: current }) ||
            upsertSubtaskPart(sessionID, part) ||
            upsertAgentPart(sessionID, part) ||
            handleBackgroundStatusText(part, current);
        if (mutated)
            bumpVersion();
    };
    const handleEvent = (props) => {
        if (!props)
            return;
        const sessionID = props.info?.sessionID ?? props.sessionID;
        const part = props.part ?? props.info?.part;
        if (!sessionID || !part)
            return;
        handlePart(sessionID, part);
    };
    const tickTimer = setInterval(() => {
        const current = Date.now();
        let pruned = false;
        for (const [key, entry] of active) {
            if (entry.completedAt && current - entry.completedAt > COMPLETION_RETENTION_MS) {
                active.delete(key);
                pruned = true;
            }
            else if (entry.status === "queued" && isStaleQueued(entry.startedAt, current)) {
                active.delete(key);
                pruned = true;
            }
        }
        if (pruned)
            bumpVersion();
        if (active.size > 0 && hasLiveEntries(active))
            setNow(current);
    }, TICK_INTERVAL_MS);
    const unsubscribers = [
        api.event.on("message.part.updated", (event) => {
            handleEvent(event.properties);
        }),
        api.event.on("message.updated", (event) => {
            const props = event.properties;
            const sessionID = props?.sessionID;
            const message = props?.info;
            if (!sessionID || !message)
                return;
            if (upsertMainMessage(sessionID, message))
                bumpVersion();
        }),
        api.event.on("message.part.removed", (event) => {
            const props = event.properties;
            const partID = props?.part?.id;
            if (!partID)
                return;
            const fgKey = makeKey("foreground", partID);
            const bgKey = makeKey("background", partID);
            if (active.delete(fgKey) || active.delete(bgKey))
                bumpVersion();
        }),
        api.event.on("tui.toast.show", (event) => {
            if (toastTimer)
                clearTimeout(toastTimer);
            setFloatingPanelTop(FLOATING_PANEL_TOAST_TOP);
            toastTimer = setTimeout(() => {
                setFloatingPanelTop(FLOATING_PANEL_TOP);
                toastTimer = undefined;
            }, event.properties.duration ?? DEFAULT_TOAST_DURATION_MS);
        }),
    ];
    api.lifecycle.onDispose(() => {
        clearInterval(tickTimer);
        if (toastTimer)
            clearTimeout(toastTimer);
        updateNotifier.dispose();
        unregisterCommand();
        for (const unsubscribe of unsubscribers)
            unsubscribe();
        active.clear();
    });
    api.slots.register({
        order: SIDEBAR_ORDER,
        slots: {
            app() {
                return buildFloatingPanel();
            },
            sidebar_content(_ctx, props) {
                return buildSidebarPanel(props.session_id);
            },
        },
    });
    function buildSidebarPanel(sessionID) {
        const box = createElement("box");
        setProp(box, "flexDirection", "column");
        setProp(box, "paddingTop", 1);
        setProp(box, "paddingBottom", 1);
        insert(box, () => {
            const mutatedFromScan = scanSessionState(sessionID);
            if (mutatedFromScan) {
                // Defer to break the self-trigger cycle: scanSessionState mutates
                // `active`, but we are inside the reactive accessor that depends on
                // `version()`. queueMicrotask schedules the bump after this run finishes.
                queueMicrotask(bumpVersion);
            }
            version();
            const tick = now();
            const status = updateStatus();
            return renderChildren(sessionID, tick, collapsed(), status);
        });
        return box;
    }
    function buildFloatingPanel() {
        const box = createElement("box");
        let floatingPanelFocused = false;
        setProp(box, "position", "absolute");
        setProp(box, "top", FLOATING_PANEL_TOP);
        setProp(box, "right", FLOATING_PANEL_RIGHT);
        setProp(box, "width", floatingPanelWidth());
        setProp(box, "overflow", "hidden");
        setProp(box, "flexDirection", "column");
        setProp(box, "paddingX", 1);
        setProp(box, "border", true);
        setProp(box, "borderColor", "gray");
        setProp(box, "backgroundColor", "black");
        setProp(box, "focusable", false);
        insert(box, () => {
            const sessionID = currentSessionID();
            const visible = sessionID !== undefined && shouldShowFloatingPanel(sessionID);
            setProp(box, "visible", visible);
            if (!visible) {
                setFloatingExpanded(false);
                resetFloatingPanelFocus(box);
                return [];
            }
            setProp(box, "top", floatingPanelTop());
            const isExpanded = floatingExpanded();
            setProp(box, "width", isExpanded ? floatingExpandedPanelWidth() : floatingPanelWidth());
            setProp(box, "focusable", isExpanded);
            setProp(box, "onMouseDown", isExpanded ? consumeFloatingPanelMouseDown : expandFloatingPanelOnMouseDown);
            setProp(box, "onKeyDown", isExpanded ? closeFloatingExpandedOnEscape : undefined);
            syncFloatingPanelFocus(box, isExpanded);
            const mutatedFromScan = scanSessionState(sessionID);
            if (mutatedFromScan)
                queueMicrotask(bumpVersion);
            version();
            const tick = now();
            const rows = isExpanded ? renderFloatingExpandedChildren(sessionID, tick) : renderFloatingChildren(sessionID, tick);
            setProp(box, "height", rows.length + FLOATING_PANEL_BORDER_ROWS);
            return rows;
        });
        return box;
        function syncFloatingPanelFocus(panel, isExpanded) {
            if (isExpanded) {
                if (!floatingPanelFocused) {
                    panel.focus();
                    floatingPanelFocused = true;
                }
                return;
            }
            resetFloatingPanelFocus(panel);
        }
        function resetFloatingPanelFocus(panel) {
            if (!floatingPanelFocused)
                return;
            if (panel.focused)
                panel.blur();
            floatingPanelFocused = false;
        }
    }
    function expandFloatingPanelOnMouseDown(event) {
        if (event.button !== MouseButton.LEFT)
            return;
        event.stopPropagation();
        setFloatingExpanded(true);
    }
    function consumeFloatingPanelMouseDown(event) {
        if (event.button !== MouseButton.LEFT)
            return;
        event.stopPropagation();
    }
    function closeFloatingExpandedOnEscape(event) {
        if (!api.keybind.match("escape", event) && event.name !== "escape")
            return;
        setFloatingExpanded(false);
        event.preventDefault();
        event.stopPropagation();
    }
    function currentSessionID() {
        const route = api.route.current;
        if (route.name !== "session" || !route.params)
            return undefined;
        const sessionID = route.params.sessionID;
        return typeof sessionID === "string" ? sessionID : undefined;
    }
    function shouldShowFloatingPanel(sessionID) {
        const sessionApi = api.state.session;
        const session = sessionApi.get?.(sessionID);
        if (session?.parentID)
            return false;
        return api.renderer.terminalWidth <= SIDEBAR_AUTO_WIDE_WIDTH || api.kv.get("sidebar", "auto") === "hide";
    }
    function floatingPanelWidth() {
        return Math.max(1, Math.min(FLOATING_PANEL_MAX_WIDTH, api.renderer.terminalWidth - 6));
    }
    function floatingExpandedPanelWidth() {
        return Math.max(1, Math.min(FLOATING_EXPANDED_PANEL_MAX_WIDTH, api.renderer.terminalWidth - 6));
    }
    function floatingExpandedPanelMaxRows() {
        return Math.max(3, Math.min(FLOATING_EXPANDED_PANEL_MAX_HEIGHT, api.renderer.terminalHeight - floatingPanelTop() - 2));
    }
    function renderFloatingChildren(sessionID, tickNow) {
        const sessionApi = api.state.session;
        const session = sessionApi.get?.(sessionID);
        const stats = collectAgentStats(sessionID, active);
        const todos = api.state.session.todo(sessionID);
        const innerWidth = floatingPanelInnerWidth();
        const status = buildFloatingStatus(stats.live, stats.done);
        const headerGap = Math.max(1, innerWidth - "Agents".length - status.length);
        const rows = [
            makeText(truncate(`Agents${" ".repeat(headerGap)}${status}`, innerWidth), {
                fg: "white",
                bold: true,
                width: "100%",
                selectable: false,
            }),
        ];
        if (innerWidth >= 20) {
            rows.push(renderFloatingLine(`Session: ${session?.title ?? "Untitled session"}`, innerWidth));
        }
        rows.push(renderFloatingLine(buildFloatingAgentSummary(stats.entries), innerWidth));
        rows.push(renderFloatingLine(buildFloatingTodoSummary(todos), innerWidth));
        rows.push(renderFloatingLine(formatFloatingActivity(stats.entries, todos, tickNow), innerWidth));
        return rows;
    }
    function renderFloatingExpandedChildren(sessionID, tickNow) {
        const sessionApi = api.state.session;
        const session = sessionApi.get?.(sessionID);
        const stats = collectAgentStats(sessionID, active);
        const main = stats.entries.filter((entry) => entry.kind === "main" && isLive(entry));
        const fg = stats.entries.filter((entry) => entry.kind === "foreground");
        const bg = stats.entries.filter((entry) => entry.kind === "background");
        const todos = api.state.session.todo(sessionID);
        const innerWidth = floatingExpandedPanelInnerWidth();
        const maxRows = floatingExpandedPanelMaxRows();
        const header = "Agents Detail";
        const hint = "Esc to close";
        const headerGap = Math.max(1, innerWidth - header.length - hint.length);
        const rows = [
            makeText(truncate(`${header}${" ".repeat(headerGap)}${hint}`, innerWidth), {
                fg: "white",
                bold: true,
                width: "100%",
                selectable: false,
            }),
        ];
        if (innerWidth >= 24 && maxRows >= 6) {
            rows.push(renderFloatingLine(`Session: ${session?.title ?? "Untitled session"}`, innerWidth));
        }
        rows.push(renderFloatingLine("Agents", innerWidth));
        const agentRows = [];
        if (stats.entries.length === 0) {
            agentRows.push(renderFloatingLine("  idle", innerWidth));
        }
        else {
            appendGroup(agentRows, "main", main, tickNow, false, innerWidth);
            appendGroup(agentRows, "foreground", fg, tickNow, main.length > 0 || bg.length > 0, innerWidth);
            appendGroup(agentRows, "background", bg, tickNow, main.length > 0 || fg.length > 0, innerWidth);
        }
        const todoRows = renderFloatingTodoRows(todos, innerWidth);
        const availableRowsAfterSections = Math.max(0, maxRows - rows.length - 1);
        const minimumTodoRows = Math.min(todoRows.length, availableRowsAfterSections, todos.length > 1 ? 2 : 1);
        const availableAgentRows = Math.max(0, availableRowsAfterSections - minimumTodoRows);
        rows.push(...limitFloatingAgentRows(agentRows, availableAgentRows, innerWidth));
        rows.push(renderFloatingLine("Todos", innerWidth));
        const availableTodoRows = Math.max(0, maxRows - rows.length);
        rows.push(...limitFloatingTodoRows(todoRows, availableTodoRows, todos, innerWidth));
        return rows;
    }
    function floatingPanelInnerWidth() {
        return Math.max(1, floatingPanelWidth() - 2);
    }
    function floatingExpandedPanelInnerWidth() {
        return Math.max(1, floatingExpandedPanelWidth() - 2);
    }
    function renderFloatingLine(content, width) {
        return renderMutedLine(truncate(content, width));
    }
    function buildFloatingStatus(live, done) {
        if (live === 0 && done > 0)
            return "done";
        if (live === 0)
            return "idle";
        return live === 1 ? "1 run" : `${live} run`;
    }
    function buildFloatingAgentSummary(entries) {
        const main = entries.some((entry) => entry.kind === "main");
        const subagents = entries.filter((entry) => entry.kind === "foreground" || entry.kind === "background").length;
        if (!main && subagents === 0)
            return "Agents: none";
        if (main && subagents === 0)
            return "Agents: main";
        const label = subagents === 1 ? "1 subagent" : `${subagents} subagents`;
        return main ? `Agents: main + ${label}` : `Agents: ${label}`;
    }
    function buildFloatingTodoSummary(todos) {
        if (todos.length === 0)
            return "Todos: none";
        const done = todos.filter((todo) => todo.status === "completed").length;
        const active = todos.filter(isActiveTodo).length;
        if (active > 0)
            return `Todos: ${done}/${todos.length} done - ${active} active`;
        const pending = todos.length - done;
        const pendingSuffix = pending > 0 ? ` - ${pending} pending` : "";
        return `Todos: ${done}/${todos.length} done${pendingSuffix}`;
    }
    function renderChildren(sessionID, tickNow, isCollapsed, status, options = {}) {
        const stats = collectAgentStats(sessionID, active);
        const main = stats.entries.filter((entry) => entry.kind === "main" && isLive(entry));
        const fg = stats.entries.filter((entry) => entry.kind === "foreground");
        const bg = stats.entries.filter((entry) => entry.kind === "background");
        const onToggle = options.interactiveHeader === false ? undefined : toggleCollapsed;
        const nodes = [renderHeader(stats.total, stats.live, stats.done, isCollapsed, status, onToggle)];
        if (isCollapsed)
            return limitRows(nodes, options.maxRows);
        if (stats.entries.length === 0) {
            nodes.push(renderMutedLine("  idle"));
            return limitRows(nodes, options.maxRows);
        }
        appendGroup(nodes, "main", main, tickNow, false);
        appendGroup(nodes, "foreground", fg, tickNow, main.length > 0 || bg.length > 0);
        appendGroup(nodes, "background", bg, tickNow, main.length > 0 || fg.length > 0);
        return limitRows(nodes, options.maxRows);
    }
};
function limitRows(nodes, maxRows) {
    return maxRows === undefined ? nodes : nodes.slice(0, maxRows);
}
function collectAgentStats(sessionID, active) {
    const entries = Array.from(active.values())
        .filter((entry) => entry.sessionID === sessionID)
        .sort(compareEntriesForDisplay);
    const visibleEntries = entries.filter((entry) => entry.kind === "main" || entry.kind === "foreground" || entry.kind === "background");
    const live = visibleEntries.filter(isLive).length;
    return {
        entries: visibleEntries,
        total: visibleEntries.length,
        live,
        done: visibleEntries.length - live,
    };
}
function isActiveTodo(todo) {
    return todo.status === "in_progress" || todo.status === "running";
}
function findCurrentTodo(todos) {
    return todos.find(isActiveTodo) ?? todos.find((todo) => todo.status === "pending");
}
function getTodoText(todo) {
    return todo.content ?? todo.text ?? todo.title ?? "todo";
}
function formatFloatingActivity(entries, todos, tickNow) {
    const running = entries.find((entry) => entry.status === "running");
    if (running) {
        if (running.kind === "main") {
            const frame = MAIN_AGENT_SPINNER_FRAMES[Math.floor(tickNow / TICK_INTERVAL_MS) % MAIN_AGENT_SPINNER_FRAMES.length];
            return `${running.agent} Running ${frame}`;
        }
        return `${running.agent} Running ${formatDuration(tickNow - running.startedAt)}`;
    }
    const queued = entries.find((entry) => entry.status === "queued");
    if (queued)
        return `${queued.agent} Queued`;
    const errored = entries.find((entry) => entry.status === "error");
    if (errored)
        return `${errored.agent} Error`;
    const todo = findCurrentTodo(todos);
    if (todo)
        return `Todo: ${getTodoText(todo)}`;
    return "idle";
}
function hasLiveEntries(active) {
    for (const entry of active.values()) {
        if (entry.status === "queued" || entry.status === "running")
            return true;
    }
    return false;
}
function compareEntriesForDisplay(a, b) {
    if (a.kind === "main" && b.kind !== "main")
        return -1;
    if (a.kind !== "main" && b.kind === "main")
        return 1;
    if (isLive(a) && !isLive(b))
        return -1;
    if (!isLive(a) && isLive(b))
        return 1;
    return b.startedAt - a.startedAt;
}
function isLive(entry) {
    return entry.status === "queued" || entry.status === "running";
}
function isExpired(completedAt, now) {
    return now - completedAt > COMPLETION_RETENTION_MS;
}
function appendGroup(nodes, label, entries, tickNow, showLabel, maxWidth) {
    if (entries.length === 0)
        return;
    if (showLabel)
        nodes.push(renderMutedLine(truncateToWidth(`  ${label}`, maxWidth)));
    for (const entry of entries) {
        nodes.push(renderAgentLine(entry, tickNow, maxWidth));
        const desc = renderDescriptionLine(entry, maxWidth);
        if (desc)
            nodes.push(desc);
    }
}
function renderFloatingTodoRows(todos, width) {
    const rows = [];
    if (todos.length === 0) {
        rows.push(renderMutedLine(truncate("  none", width)));
        return rows;
    }
    for (const todo of todos) {
        rows.push(makeText(truncate(`${formatTodoStatusMarker(todo.status)} ${getTodoText(todo)}`, width), {
            fg: pickTodoStatusColor(todo.status),
        }));
    }
    return rows;
}
function limitFloatingAgentRows(rows, maxRows, width) {
    if (rows.length <= maxRows)
        return rows;
    if (maxRows <= 0)
        return [];
    const hiddenRows = rows.length - maxRows + 1;
    return [...rows.slice(0, maxRows - 1), renderMutedLine(truncate(`... ${hiddenRows} more agent lines`, width))];
}
function limitFloatingTodoRows(rows, maxRows, todos, width) {
    if (rows.length <= maxRows)
        return rows;
    if (maxRows <= 0)
        return [];
    const hiddenTodos = Math.max(1, todos.length - maxRows + 1);
    return [...rows.slice(0, maxRows - 1), renderMutedLine(truncate(`... ${hiddenTodos} more todos`, width))];
}
function formatTodoStatusMarker(status) {
    if (status === "completed")
        return "✓";
    if (status === "in_progress" || status === "running")
        return "●";
    if (status === "cancelled" || status === "canceled")
        return "×";
    return "○";
}
function pickTodoStatusColor(status) {
    if (status === "completed")
        return "gray";
    if (status === "in_progress" || status === "running")
        return "white";
    if (status === "cancelled" || status === "canceled")
        return "red";
    return "gray";
}
function renderHeader(total, live, done, isCollapsed, status, onToggle) {
    const chevron = isCollapsed ? "▶" : "▼";
    const updateSuffix = status?.isUpdateAvailable ? `  [⬆ v${status.latest} available]` : "";
    const handleMouseDown = onToggle
        ? (event) => {
            if (event.button !== MouseButton.LEFT)
                return;
            event.stopPropagation();
            onToggle();
        }
        : undefined;
    return makeText(`${chevron} Agents ${buildCountSuffix(total, live, done)}${updateSuffix}`, {
        fg: "white",
        bold: true,
        width: "100%",
        selectable: false,
        onMouseDown: handleMouseDown,
    });
}
function buildCountSuffix(total, live, done) {
    if (total === 0)
        return "(0)";
    if (live > 0 && done > 0)
        return `(${live} active, ${done} done)`;
    if (done > 0)
        return `(${done} done)`;
    return `(${live})`;
}
function renderAgentLine(entry, tickNow, maxWidth) {
    if (entry.kind === "main" && entry.status === "running") {
        const frame = MAIN_AGENT_SPINNER_FRAMES[Math.floor(tickNow / TICK_INTERVAL_MS) % MAIN_AGENT_SPINNER_FRAMES.length];
        return makeText(truncateToWidth(`  • ${entry.agent} Running ${frame}`, maxWidth), {
            fg: pickLineColor(entry),
        });
    }
    const elapsedMs = entry.completedAt ? entry.completedAt - entry.startedAt : tickNow - entry.startedAt;
    const elapsed = formatDuration(elapsedMs);
    return makeText(truncateToWidth(`  • ${entry.agent} ${formatStatus(entry.status)} ${elapsed}`, maxWidth), {
        fg: pickLineColor(entry),
    });
}
function renderDescriptionLine(entry, maxWidth) {
    if (entry.description.length === 0)
        return undefined;
    if (entry.kind === "main" && entry.agent === entry.description)
        return undefined;
    return makeText(truncateToWidth(`    ${truncate(entry.description, DESCRIPTION_MAX_LEN)}`, maxWidth), { fg: "gray" });
}
function formatStatus(status) {
    if (status === "queued")
        return "Queued";
    if (status === "running")
        return "Running";
    if (status === "completed")
        return "Done";
    return "Error";
}
function pickLineColor(entry) {
    if (entry.status === "queued")
        return "gray";
    if (entry.status === "running")
        return "white";
    if (entry.status === "completed")
        return "gray";
    return "red";
}
function renderMutedLine(content) {
    return makeText(content, { fg: "gray" });
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
function truncate(value, maxLen) {
    if (maxLen <= 0)
        return "";
    if (value.length <= maxLen)
        return value;
    if (maxLen === 1)
        return "…";
    return `${value.slice(0, maxLen - 1)}…`;
}
function truncateToWidth(value, maxWidth) {
    return maxWidth === undefined ? value : truncate(value, maxWidth);
}
function makeText(content, props = {}) {
    const node = createElement("text");
    for (const [key, value] of Object.entries(props)) {
        if (value !== undefined)
            setProp(node, key, value);
    }
    insert(node, content);
    return node;
}
const plugin = {
    id: PLUGIN_ID,
    tui,
};
export default plugin;
//# sourceMappingURL=tui.js.map