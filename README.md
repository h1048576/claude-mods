# Claude Code Mods

个人 Claude Code 插件（mods）集合。每个子目录都是一个独立的 Claude Code 插件，通过 hooks 实现界面定制与行为增强，在本会话中热加载，无需重启。

## 当前包含的插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [show-mode](./show-mode) | 0.3.0 | 隐藏工具调用与思考/叙述痕迹，仅 hidden 模式保存文件 diff 与思考过程供回看 |

## 环境要求

- [Claude Code](https://docs.claude.com/en/docs/claude-code)（支持插件/mod 热加载的版本）
- 开发或运行测试时需要 Node.js（TypeScript 类型检查与测试运行）

## 安装

### 方式一：克隆到 mods 目录（推荐）

将本仓库克隆到 Claude Code 的 mods 目录 `~/.claude/mods/` 下，插件会在会话中自动热加载：

```bash
# Windows（PowerShell）
git clone <本仓库地址> "$env:USERPROFILE\.claude\mods"

# macOS / Linux
git clone <本仓库地址> ~/.claude/mods
```

> 注意：如果 `~/.claude/mods` 目录已存在，可以克隆到临时目录后把需要的插件子目录（如 `show-mode/`）复制进去。

克隆后的目录结构：

```
~/.claude/mods/
└── show-mode/
    ├── .claude-plugin/
    │   ├── plugin.json        # 插件清单（名称、版本、用户配置项）
    │   └── types/             # claude-code API 类型定义
    ├── hooks/
    │   ├── hooks.json         # 模块入口声明
    │   ├── register.tsx       # 插件主逻辑（hooks 注册）
    │   └── register.test.tsx  # 测试
    ├── types/
    │   └── index.d.ts         # 插件状态与数据结构类型
    └── tsconfig.json
```

### 方式二：作为本地插件启用

如果只想启用其中某个插件，也可以在 Claude Code 会话内通过 `/plugin` 命令管理，或将插件目录添加到本地 marketplace 后安装。

## 配置

### 显示模式（userConfig）

`show-mode` 在插件清单（`show-mode/.claude-plugin/plugin.json`）中声明了一个用户配置项：

| 配置项 | 类型 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `mode` | string | `off` / `hidden` | `hidden` | `off`=正常显示且不新增记录；`hidden`=隐藏过程并保存文件 diff 与思考过程 |

- **off**：正常显示所有工具调用、思考与过程叙述，不新增任何记录。
- **hidden**：隐藏工具调用行、思考过程与过程叙述，但在后台保存：
  - 文件更新 diff（最多 100 条）
  - 思考块、过程叙述、工具/技能调用记录（最多 100 条，每条正文最多保留 5 行）
  - 超出上限时自动删除最旧的记录
  - 最终回答和工具错误始终保留，不受影响。

运行时模式优先于清单配置：通过 `/show-mode` 命令切换后，以切换后的值为准；未切换时回落到清单配置的默认值。

## 使用

安装后在会话中使用 `/show-mode` 命令：

```
/show-mode              # 在 off 和 hidden 之间切换
/show-mode off          # 切换到正常显示模式
/show-mode hidden       # 切换到隐藏模式
/show-mode status       # 查看当前模式与保存记录统计
/show-mode view         # 回看最近的记录（文件 diff + 思考过程，每类最近 10 条）
/show-mode view code    # 只回看文件更新 diff（diff 语法着色，最近 10 条）
/show-mode view think   # 只回看思考过程（含工具/技能调用记录，最近 10 条）
/show-mode view all     # 回看更多记录（每类最近 30 条）
/show-mode view clear   # 清空全部保存的文件 diff 和思考过程记录
```

说明：

- 回看不受当前显示模式限制，`off` 模式下也可以查看之前 `hidden` 模式保存的记录。
- 回看默认只显示最近的记录（每类 10 条），`view all` 可查看每类最近 30 条。
- 回看输出按记录类型着色渲染：code 记录按 diff 增删行着色，think 记录标题高亮、正文每行截断不折行。
- 记录按时间排序展示，每条带编号、时间戳、类型与来源（新增/修改、所用工具等）。
- 出错或被中断的工具调用在任何模式下都会照常显示，方便排查问题。
- Spinner 状态行在任何模式下都不隐藏——这是唯一能看到"还在干活"的地方。
- 文件 diff 不依赖 Git，新文件、未暂存文件和非 Git 目录均可回看。

## 开发

```bash
cd show-mode
npx tsc --noEmit        # 类型检查
```

- 插件入口：`show-mode/hooks/register.tsx`，通过 `register: Register` 导出，使用 `on()` 订阅生命周期与渲染事件。
- 状态存储：使用 `claude-code` 提供的 `atom` / `read` / `update`，按 `plugin` + `key` 隔离。
- 类型定义：`show-mode/types/index.d.ts` 扩展了 `claude-code` 的 `PluginState` 接口。
- 测试：`show-mode/hooks/register.test.tsx`，基于 `claude-code/testing`。

## 目录结构

```
.
├── README.md
└── show-mode/           # show-mode 插件
    ├── .claude-plugin/  # 插件清单与官方类型
    ├── hooks/           # hooks 逻辑与测试
    ├── types/           # 插件类型声明
    └── tsconfig.json    # TypeScript 配置
```
