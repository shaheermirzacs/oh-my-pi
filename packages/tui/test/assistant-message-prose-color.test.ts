import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { getThemeByName, initTheme, setMarkdownColorful, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { extractCodeBlocks } from "@oh-my-pi/pi-tui/overlays/copy-targets";

const RENDER_WIDTH = 80;
const PROSE = "Assistant prose must be themeable.";
/** Distinctive hue for the token; its escape depends on the terminal's color depth. */
const TOKEN_HEX = "#ff00ff";
/** The base dark theme JSON — a known-valid theme we extend with the token. */
const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "theme", "dark.json");

const originalImageProtocol = TERMINAL.imageProtocol;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let tmpAgentDir: string;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Write a custom theme (the dark palette plus `colors` overrides) into the temp
 * agent dir and activate it. Loading goes through `parseThemeJson`, so this also
 * proves the runtime schema accepts the token.
 *
 * Returns the activated theme so callers can derive the token's escape through the
 * same public accessor the component uses: the concrete bytes depend on the
 * terminal's detected color depth (truecolor vs 256), which differs between a
 * local Windows Terminal and CI.
 */
async function applyTheme(name: string, colors: Record<string, string>) {
	const dark = (await Bun.file(DARK_THEME_PATH).json()) as Record<string, unknown>;
	const baseColors = (dark.colors ?? {}) as Record<string, unknown>;
	const themesDir = getCustomThemesDir();
	await fs.mkdir(themesDir, { recursive: true });
	await Bun.write(
		path.join(themesDir, `${name}.json`),
		JSON.stringify({ ...dark, name, colors: { ...baseColors, ...colors } }, null, 2),
	);
	const loaded = await getThemeByName(name);
	if (!loaded) throw new Error(`theme ${name} failed to load`);
	setThemeInstance(loaded);
	return loaded;
}

beforeAll(async () => {
	await initTheme(false);
});

/** Restore the process-wide theme so later suites in the same run see the default dark theme. */
afterAll(async () => {
	const dark = await getThemeByName("dark");
	if (dark) setThemeInstance(dark);
});

beforeEach(async () => {
	tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prose-color-"));
	setAgentDir(tmpAgentDir);
	setTerminalImageProtocol(null);
});

afterEach(async () => {
	setTerminalImageProtocol(originalImageProtocol);
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await removeWithRetries(tmpAgentDir);
});

describe("assistant prose theme token", () => {
	// Regression for #11204: assistant paragraph prose had no token and always
	// rendered at the terminal default foreground.
	it("paints assistant paragraph prose with the assistantMessageText token", async () => {
		const theme = await applyTheme("prose-colored", { assistantMessageText: TOKEN_HEX });

		const rendered = new AssistantMessageComponent(assistantMessage(PROSE)).render(RENDER_WIDTH).join("\n");

		expect(rendered).toContain(theme.fg("assistantMessageText", PROSE));
		expect(Bun.stripANSI(rendered)).toContain(PROSE);
	});

	it("leaves prose in the terminal default foreground when the token is unset", async () => {
		await applyTheme("prose-unset", {});

		const rendered = new AssistantMessageComponent(assistantMessage(PROSE)).render(RENDER_WIDTH).join("\n");
		const proseLine = rendered.split("\n").find(line => line.includes(PROSE));

		// Row-padded, but the prose run carries no foreground SGR at all.
		expect(proseLine?.trimEnd()).toBe(` ${PROSE}`);
	});

	it("resolves an omitted optional token to the terminal default", async () => {
		// A model-role color may name this token even when the active theme omits
		// it; painting it must degrade to the terminal default, not throw.
		const theme = await applyTheme("prose-omitted", {});

		expect(theme.hasColor("assistantMessageText")).toBe(false);
		expect(theme.fg("assistantMessageText", PROSE)).toBe(`\x1b[39m${PROSE}\x1b[39m`);
	});

	it("keeps an explicitly installed prose color transform over the token", async () => {
		const theme = await applyTheme("prose-explicit", { assistantMessageText: TOKEN_HEX });
		const green = "\x1b[38;2;0;255;0m";
		// Live-command output installs the transform on a fresh component before
		// its content arrives; mirror that ordering.
		const component = new AssistantMessageComponent();
		component.setTextColorTransform(text => `${green}${text}\x1b[39m`);
		component.updateContent(assistantMessage(PROSE));

		const rendered = component.render(RENDER_WIDTH).join("\n");

		expect(rendered).toContain(green);
		expect(rendered).not.toContain(theme.fg("assistantMessageText", PROSE));
	});

	// D2 regression (PR #11260): markdown sub-elements must keep their own
	// md* token colors; the prose token paints plain runs only, and the
	// mdHeading/mdLink escape stays the innermost (winning) SGR.
	it("keeps mdHeading and mdLink colors over the assistant prose token", async () => {
		const theme = await applyTheme("prose-md-precedence", { assistantMessageText: TOKEN_HEX });
		const md = "# Heading One\n\nplain paragraph with [link](https://example.com)";

		setMarkdownColorful(false);
		let rendered: string;
		try {
			rendered = new AssistantMessageComponent(assistantMessage(md)).render(RENDER_WIDTH).join("\n");
		} finally {
			setMarkdownColorful(true);
		}
		const headingLine = rendered.split("\n").find(line => line.includes("Heading One")) ?? "";
		const linkLine = rendered.split("\n").find(line => line.includes("link")) ?? "";

		// mdHeading wins inside the heading: its escape encloses the heading text
		// with no prose-color escape between it and the text.
		expect(headingLine).toContain(theme.fg("mdHeading", "Heading One"));
		expect(headingLine).not.toContain(theme.fg("assistantMessageText", "Heading One"));
		// mdLink wins inside the link text.
		expect(linkLine).toContain(theme.fg("mdLink", "link"));
		expect(linkLine).not.toContain(theme.fg("assistantMessageText", "link"));
		// Plain prose runs still carry the token.
		expect(rendered).toContain(theme.fg("assistantMessageText", "plain paragraph with "));
	});

	it("keeps colorful Markdown role colors over the assistant prose token", async () => {
		const theme = await applyTheme("prose-colorful-precedence", { assistantMessageText: TOKEN_HEX });
		const md = "# Heading One\n\nplain with **strong words** and *soft words*";

		const rendered = new AssistantMessageComponent(assistantMessage(md)).render(RENDER_WIDTH).join("\n");

		for (const words of ["Heading One", "strong words", "soft words"]) {
			expect(rendered).toContain(theme.ansiFg("magenta", words));
			expect(rendered).not.toContain(theme.fg("assistantMessageText", words));
		}
		expect(rendered).toContain(theme.fg("assistantMessageText", "plain with "));
	});

	// D1 regression (PR #11260): the stable-snapshot renderer must use the
	// same prose transform as the live child Markdown; otherwise the frozen
	// prefix's bytes diverge from the live render and #publishStableSnapshot's
	// byte-prefix guard silently disables mid-stream scrollback publication.
	it("publishes token-colored streaming prose as stable scrollback rows", async () => {
		const theme = await applyTheme("prose-stable-stream", { assistantMessageText: TOKEN_HEX });
		const full =
			"The first paragraph of a streaming turn is long enough to wrap onto its own rows. ".repeat(2) +
			"\n\nThe second paragraph is still being streamed.";
		const component = new AssistantMessageComponent();
		component.updateContent(assistantMessage(`${full.slice(0, 60)}\n\nSec`), { transient: true });
		component.render(RENDER_WIDTH);
		component.updateContent(assistantMessage(full), { transient: true });
		component.render(RENDER_WIDTH);

		const stableCount = component.getTranscriptStableRows().length;
		expect(stableCount).toBeGreaterThan(0);
		const stableRows = component.renderTranscriptStableRows(stableCount, RENDER_WIDTH);
		// Published prefix is painted with the prose token — the wrap may split
		// the phrase mid-word, so assert the row's prose text opens with the
		// token escape exactly as the live render's first row does.
		const tokenEscape = theme.fg("assistantMessageText", "x").split("x").join("").replace("\x1b[39m", "");
		const firstProseRow = stableRows.find(row => row.includes("The first paragraph"));
		expect(firstProseRow?.startsWith(` ${tokenEscape}The first`)).toBe(true);
	});

	it("keeps the explicit transform painting headings and links (live-command contract)", async () => {
		await applyTheme("prose-explicit-md", { assistantMessageText: TOKEN_HEX });
		const green = "\x1b[38;2;0;255;0m";
		const component = new AssistantMessageComponent();
		component.setTextColorTransform(text => `${green}${text}\x1b[39m`);
		const md = "# Heading One\n\nplain paragraph with [link](https://example.com)";
		component.updateContent(assistantMessage(md));

		const rendered = component.render(RENDER_WIDTH).join("\n");

		// The live-command transform paints every run, including semantically
		// themed spans; only mdLinkUrl keeps its own token (never passed through
		// the prose transform, matching pre-token behavior).
		expect(rendered).toContain(`${green}Heading One`);
		expect(rendered).toContain(`${green}link`);
		expect(rendered).toContain(`${green}plain paragraph with`);
	});

	it("renders assistant code without displaying fence delimiters", () => {
		const source = "1. Run:\n   ```bash\n   cat <<'EOF'\n   hello\n   EOF\n   ```\n2. Next item\n\n```bash\nbrew install example\n```";
		const lines = new AssistantMessageComponent(assistantMessage(source))
			.render(RENDER_WIDTH)
			.map(line => Bun.stripANSI(line).trimEnd());

		expect(lines.join("\n")).not.toContain("```");
		expect(lines).toContain("cat <<'EOF'");
		expect(lines).toContain("hello");
		expect(lines).toContain("EOF");
		expect(lines).toContain(" 2. Next item");
		expect(lines).toContain("brew install example");
		const leading = new AssistantMessageComponent(assistantMessage("1. ```sh\n   echo one\n   ```\n2. Next"))
			.render(RENDER_WIDTH)
			.map(line => Bun.stripANSI(line).trimEnd());
		expect(leading.slice(0, 2)).toEqual([" 1.", "echo one"]);
		expect(leading).toContain(" 2. Next");
		expect(extractCodeBlocks(source)).toEqual([
			{ lang: "bash", code: "cat <<'EOF'\nhello\nEOF" },
			{ lang: "bash", code: "brew install example" },
		]);
	});

	it("advances list-code scrollback before the closing fence arrives", () => {
		const component = new AssistantMessageComponent();
		let previousCount = 0;
		for (const lineCount of [8, 24]) {
			const code = Array.from({ length: lineCount }, (_, index) => `   const row${index} = ${index};`).join("\n");
			const source = `First paragraph.\n\n1. Run:\n   \`\`\`ts\n${code}\n   const pending =`;
			component.updateContent(assistantMessage(source), { transient: true });
			const rendered = component.render(RENDER_WIDTH);
			const count = component.getTranscriptStableRows().length;
			expect(count).toBeGreaterThan(previousCount);
			const stable = component.renderTranscriptStableRows(count, RENDER_WIDTH);
			expect(stable).toEqual(rendered.slice(0, stable.length));
			expect(Bun.stripANSI(stable.join("\n"))).toContain(`const row${lineCount - 2} = ${lineCount - 2};`);
			previousCount = count;
		}
	});

	it("keeps streaming code and stable replay identical through fence closure", () => {
		for (const source of [
			"First paragraph.\n\n```ts\nconst first = 1;\nconst last = 2;\n```\n\nDone.",
			"First paragraph.\n\n1. Run:\n   ```ts\n   const first = 1;\n   const last = 2;\n   ```\n2. Next.\n\nDone.",
		]) {
			const component = new AssistantMessageComponent();
			for (let end = 1; end <= source.length; end++) {
				component.updateContent(assistantMessage(source.slice(0, end)), { transient: true });
				component.render(RENDER_WIDTH);
			}
			component.updateContent(assistantMessage(source));
			const rendered = component.render(RENDER_WIDTH);
			expect(rendered).toEqual(new AssistantMessageComponent(assistantMessage(source)).render(RENDER_WIDTH));
			expect(Bun.stripANSI(rendered.join("\n"))).toContain("const last = 2;");
			expect(Bun.stripANSI(rendered.join("\n"))).not.toContain("```");
			const count = component.getTranscriptStableRows().length;
			expect(count).toBeGreaterThan(0);
			const stable = component.renderTranscriptStableRows(count, RENDER_WIDTH);
			expect(stable).toEqual(rendered.slice(0, stable.length));
			expect(Bun.stripANSI(stable.join("\n"))).toContain("const last = 2;");
		}
	});

	it("separates code from prose and adjacent blocks by exactly one blank row", () => {
		const cases = [
			"Before\n```sh\necho first\n```\nAfter",
			"Before\n\n```sh\necho first\n```\n\nAfter",
			"1. Before\n   ```sh\n   echo first\n   ```\n2. After",
			"1. Before\n\n   ```sh\n   echo first\n   ```\n\n2. After",
			"1. Before\n   ```sh\n   echo first\n   ```\n   After",
			"1. Before\n   ```sh\n   echo first\n   ```\n\nAfter",
			"1. Before\n```sh\necho first\n```\nAfter",
			"1. Before\n   ```sh\n   echo first\n   ```\n   ```sh\n   echo second\n   ```\n2. After",
		];
		for (const source of cases) {
			for (const width of [42, 80]) {
				const lines = new AssistantMessageComponent(assistantMessage(source))
					.render(width)
					.map(line => Bun.stripANSI(line).trim());
				const labels = source.includes("echo second")
					? ["Before", "echo first", "echo second", "After"]
					: ["Before", "echo first", "After"];
				for (let index = 1; index < labels.length; index++) {
					const before = lines.findIndex(line => line.includes(labels[index - 1]!));
					const after = lines.findIndex(line => line.includes(labels[index]!));
					expect(after - before).toBe(2);
					expect(lines[before + 1]).toBe("");
				}
			}
		}
	});
});
