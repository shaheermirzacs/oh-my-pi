import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDisplayHideToolActivity } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withoutTerminalMultiplexer } from "../../../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

withoutTerminalMultiplexer();

describe("InputController tool output expansion", () => {
	it("expands transcript and pending shell children without rebuilding their components", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const pendingShell = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			pendingShellContainer: { children: [pendingShell] },
			redrawTranscriptBlocks: vi.fn(),
			ui: { requestRender },
			showStatus,
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(pendingShell.setExpanded).toHaveBeenCalledWith(true);
		expect(ctx.redrawTranscriptBlocks).toHaveBeenCalledWith([expandable, inert], expect.any(Function));
		expect(requestRender).toHaveBeenCalledWith(true);
		expect(showStatus).toHaveBeenCalledWith("Tool output expansion: enabled");
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getKeys: vi.fn(() => ["alt+h"]) },
			showStatus,
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool expansion in terminal scrollback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let composer: Composer;
	let terminal: VirtualTerminal;
	let scheduler: VirtualRenderScheduler;
	let tool: ToolExecutionComponent;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-tool-expansion-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		terminal = new VirtualTerminal(100, 16);
		scheduler = new VirtualRenderScheduler();
		composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
		const editor = new Container();
		editor.addChild(new Text("LIVE_EDITOR_DRAFT", 0, 0));
		composer.setRuntimeChildren([mode.chatContainer, mode.pendingShellContainer, editor], {
			transientChrome: [editor],
		});
		composer.start({ playWelcomeIntro: false });
		tool = new ToolExecutionComponent("history_tool", {}, {}, undefined, mode.ui);
		tool.setArgsComplete();
		tool.setExecutionStarted();
		tool.updateResult(
			{
				content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `HISTORY_OUTPUT_${i}_END`).join("\n") }],
				isError: false,
			},
			false,
		);
		mode.chatContainer.addChild(tool);
	});

	afterEach(async () => {
		tool?.dispose();
		composer?.stop();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function buffer(): string[] {
		return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	}

	async function retireTool(): Promise<void> {
		for (let i = 0; i < 20; i++) mode.chatContainer.addChild(new Text(`FOLLOWING_MESSAGE_${i}_END`, 0, 0));
		mode.ui.requestRender();
		await scheduler.settle(terminal);
		expect(mode.chatContainer.canRemoveBlock(tool)).toBe(false);
		const { baseY } = terminal.getBufferPosition();
		expect(buffer().slice(0, baseY).some(row => row.includes("history_tool"))).toBe(true);
	}

	function expectNoDuplicates(): void {
		const rows = buffer();
		for (let i = 0; i < 20; i++) {
			expect(rows.filter(row => row.includes(`FOLLOWING_MESSAGE_${i}_END`))).toHaveLength(1);
		}
		expect(rows.filter(row => row.includes("history_tool"))).toHaveLength(1);
		expect(rows.filter(row => row.includes("LIVE_EDITOR_DRAFT"))).toHaveLength(1);
	}

	it("collapses output expanded before its card retired, then expands the retired card again", async () => {
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");
		mode.setToolsExpanded(true);
		await scheduler.settle(terminal);
		expect(resetDisplay).not.toHaveBeenCalled();
		await retireTool();
		expect(buffer().filter(row => row.includes("HISTORY_OUTPUT_20_END"))).toHaveLength(1);

		mode.setToolsExpanded(false);
		await scheduler.settle(terminal);
		expect(buffer().some(row => row.includes("HISTORY_OUTPUT_20_END"))).toBe(false);
		expectNoDuplicates();

		mode.setToolsExpanded(true);
		await scheduler.settle(terminal);
		for (let i = 0; i < 40; i++) {
			expect(buffer().filter(row => row.includes(`HISTORY_OUTPUT_${i}_END`))).toHaveLength(1);
		}
		expectNoDuplicates();
	});

	it("expands a card first retired while collapsed without duplicating its history", async () => {
		await retireTool();
		expect(buffer().some(row => row.includes("HISTORY_OUTPUT_20_END"))).toBe(false);

		mode.setToolsExpanded(true);
		await scheduler.settle(terminal);
		for (let i = 0; i < 40; i++) {
			expect(buffer().filter(row => row.includes(`HISTORY_OUTPUT_${i}_END`))).toHaveLength(1);
		}
		expectNoDuplicates();
		// A later ordinary frame must not append another copy of the replayed history.
		mode.ui.requestRender();
		await scheduler.settle(terminal);
		expectNoDuplicates();
		expect(buffer().filter(row => row.includes("HISTORY_OUTPUT_20_END"))).toHaveLength(1);
	});

	it("does not clear scrollback for retired cards on a native surface", async () => {
		await retireTool();
		const resetDisplay = vi.spyOn(mode.ui, "resetDisplay");
		const wasNative = isNativeRendering();
		try {
			setNativeRendering(true);
			mode.setToolsExpanded(true);
			expect(mode.toolOutputExpanded).toBe(true);
			expect(resetDisplay).not.toHaveBeenCalled();
		} finally {
			setNativeRendering(wasNative);
		}
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, preserves transient children, and reveals tools collapsed", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setToolResultImagesVisible = vi.spyOn(assistant, "setToolResultImagesVisible");
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const settings = Settings.isolated();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const setToolActivityVisible = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings,
			chatContainer: { children, clear, addChild, setToolActivityVisible },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: hidden");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(cfgDisplayHideToolActivity.get(settings)).toBe(false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("Tool activity: visible");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
		expect(setToolActivityVisible).toHaveBeenLastCalledWith(true);
	});
});
