window.__ModuleLoader__.load({
	id: "dsh-claude-code-sdk",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region 常量
		/**
		 * 开关打开时写进草稿的前缀。技能被选中时插入的就是纯文本 `/{name} `，
		 * 所以这里保持同样的形状即可被 DSH 解析成技能调用。
		 * 必须与服务端 lib/index.js 的 CLAUDE_MODE_PREFIX 一致。
		 */
		const PREFIX = "/claude-mode ";
		/** localStorage 里的会话级开关表。 */
		const STORAGE_KEY = "dsh-claude-mode";
		//#endregion

		//#region 开关状态（按会话持久化）
		function readMap() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (raw === null || raw === "") return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}

		function readFlag(sessionId) {
			return readMap()[sessionId] === true;
		}

		function writeFlag(sessionId, on) {
			try {
				const map = readMap();
				if (on) map[sessionId] = true;
				else delete map[sessionId];
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
			} catch {
				/* 隐私模式下 localStorage 可能不可写，开关退化为本次会话内有效 */
			}
		}
		//#endregion

		//#region 样式
		function styleFor(on) {
			return {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				height: "24px",
				padding: "0 8px",
				borderRadius: "999px",
				border: `1px solid ${on ? "currentColor" : "color-mix(in srgb, currentColor 28%, transparent)"}`,
				background: on ? "color-mix(in srgb, currentColor 14%, transparent)" : "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				lineHeight: 1,
				cursor: "pointer",
				opacity: on ? 1 : 0.72,
				whiteSpace: "nowrap",
				transition: "opacity 120ms ease, background 120ms ease",
			};
		}
		//#endregion

		//#region 组件
		/**
		 * 输入框右侧的「Claude 模式」开关。
		 *
		 * 打开时把 `/claude-mode ` 写进草稿，之后每条消息都会带上这个技能，
		 * 模型据此把任务全部委派给 claude_code。关闭时把前缀摘掉。
		 *
		 * @param props - 插槽标准属性（会话 id、输入状态、输入动作）
		 * @returns 开关按钮
		 */
		function ClaudeModeToggle(props) {
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const input = props.useInput((state) => state);
			const draft = input !== undefined && typeof input.draft === "string" ? input.draft : "";

			const [on, setOn] = react.useState(() => readFlag(sessionId));

			// 上一次看到的草稿，用来判断「刚提交完」这个瞬间
			const previousDraft = react.useRef(draft);

			react.useEffect(() => {
				const wasNonEmpty = previousDraft.current !== "";
				previousDraft.current = draft;
				// 只在「有内容 → 清空」这个跳变上补前缀，避免和用户手动清空抢
				if (!on || !wasNonEmpty || draft !== "" || inputActions === undefined) return;
				inputActions.setDraft(PREFIX);
			}, [draft, on, inputActions]);

			// 会话切换时重新读一次该会话的开关
			react.useEffect(() => {
				setOn(readFlag(sessionId));
			}, [sessionId]);

			const toggle = react.useCallback(() => {
				const next = !on;
				setOn(next);
				writeFlag(sessionId, next);
				if (inputActions === undefined) return;
				if (next) {
					if (!draft.startsWith(PREFIX)) inputActions.setDraft(PREFIX + draft);
				} else if (draft.startsWith(PREFIX)) {
					inputActions.setDraft(draft.slice(PREFIX.length));
				}
			}, [on, draft, sessionId, inputActions]);

			return react.createElement(
				"button",
				{
					type: "button",
					onClick: toggle,
					"aria-pressed": on,
					"aria-label": on ? "Claude 模式已开启，点击关闭" : "开启 Claude 模式，所有任务交给 Claude Code",
					title: on
						? "Claude 模式：开。本会话所有任务交给 Claude Code；再点一次关闭。"
						: "Claude 模式：关。点一下开启，之后所有任务都委派给 Claude Code。",
					style: styleFor(on),
				},
				on ? "Claude 模式 · 开" : "Claude 模式",
			);
		}
		//#endregion

		//#region 插件入口
		/** 依赖的客户端服务：UI 插槽注册表。 */
		const inject = ["slots"];

		/**
		 * 把开关挂到输入框右侧（提交按钮之前的那排紧凑控件里）。
		 * @param ctx - 客户端根上下文
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register(
					{
						name: "conversation.input.right",
						id: "claude-mode",
						order: 100,
						label: "Claude 模式",
					},
					ClaudeModeToggle,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
