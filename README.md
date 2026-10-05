# Claude Code Mods

个人 Claude Code 插件（mods）集合。每个子目录都是一个独立的 Claude Code 插件，通过 hooks 实现界面定制与行为增强，在本会话中热加载，无需重启。

## 当前包含的插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [show-mode](./show-mode) | 0.3.0 | hidden 模式仅实时展示当前思考，隐藏工具调用与过程痕迹，保存文件 diff 与思考过程供回看 |
| [shell-mode](./shell-mode) | 0.3.0 | 用 `/shell-mode` 切换 Bash 控制台，显示输出颜色，退出后将命令和结果保留在 CLI 中 |

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
| `mode` | string | `off` / `hidden` | `hidden` | `off`=正常显示且不新增记录；`hidden`=仅展示当前思考，并保存文件 diff 与思考过程 |

- **off**：正常显示所有工具调用、思考与过程叙述，不新增任何记录。
- **hidden**：隐藏工具调用行与过程叙述的最终渲染，改为在 Spinner 状态行上方实时展示当前思考（下一块替换上一块，回合结束即清理）；同时在后台保存：
  - 文件更新 diff（最多 100 条）
  - 思考块、过程叙述、工具/技能调用记录（最多 100 条，每条正文最多保留 5 行）
  - 超出上限时自动删除最旧的记录
  - 已确认的最终回答恢复原生 Markdown 渲染；所有工具调用、结果和运行提示均隐藏，包括错误及中断。

运行时模式优先于清单配置：通过 `/show-mode` 命令切换后，以切换后的值为准；未切换时回落到清单配置的默认值。

## 使用

安装后在会话中使用 `/show-mode` 命令：

```
/show-mode off          # 切换到正常显示模式
/show-mode hidden       # 切换到仅展示当前思考模式
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
- hidden 模式下出错或被中断的工具调用及结果也会隐藏，off 模式下恢复正常显示。
- hidden 模式下思考正文与 Spinner 状态行显示在同一列，状态行始终位于思考正文之后。
- 文件 diff 不依赖 Git，新文件、未暂存文件和非 Git 目录均可回看。

### Shell Mode

在项目目录启动 Claude Code 时加载插件：

```powershell
claude --plugin-dir "$env:USERPROFILE\.claude\mods\shell-mode"
```

先在 Claude Code 输入框中输入 `/shell-mode`，然后在打开的控制台 `$` 后输入命令：

```text
/shell-mode         # 未开启时进入 Bash 模式
pwd
ls
cd internal
git status
/shell-mode         # 已开启时退出，返回正常 Claude 对话
```

进入后，控制台取得键盘焦点，在 `$` 后输入命令并回车。再次输入 `/shell-mode`、输入 `exit` 或按 Esc 关闭控制台，返回 Claude 对话。在 Claude 输入框和 Shell 控制台中输入 `/shell-mode` 都可以退出已开启的模式。`/shell-mode on` 和 `/shell-mode off` 仍可用于明确开启或关闭，无须强制指定参数。控制台位置由 Claude Code 决定：通常位于输入框上方，全屏且窗口足够宽时位于侧边。

控制台直接显示命令和原始输出，不使用带插件名前缀的日志，也不触发 `Prompt dropped by a hook` 提示，不显示成功提示或退出码：

```text
$ ls
config docs go.mod main.go

$ git status
On branch test
nothing to commit, working tree clean

$
```

每条命令由 Git Bash 直接执行，不主动启动模型回合。实际命令与输出保存在本地，CLI 的原生命令记录仅保存短引用，模型后续只能读取该引用。支持管道、重定向和连续 `cd`，后续命令沿用上次结束时的目录。退出后再次进入，从 Claude 会话目录开始。

每条命令完成后增加一个空行，分隔相邻命令块。退出控制台时，把当前保留的命令和结果保存到 `%LOCALAPPDATA%/Claude/shell-mode/history/`，再通过 CLI 命令记录中的引用读取并渲染，继续显示在对话屏幕上，保留换行和颜色。通过 `/shell-mode`、`exit`、Esc 或窗格关闭按钮退出均会保留输出。重绘和插件重载时也从本地存档恢复；清理该目录会使对应的历史输出无法再次显示。

保留 Claude 原生窗格的自动输入焦点。窗格的 × 和输入框的回车图标由 Claude 绘制，当前公开接口没有隐藏开关，因此这两个图标保留。

直接显示的 `ls` 按控制台宽度多列排版；`ll` 等别名仍使用 Bash 配置。普通文件、目录、链接等颜色由 `ls` 和 `LS_COLORS` 确定。`git status`、`git diff` 等直接显示的 Git 输出启用 Git 自带的颜色；其他程序明确输出的 ANSI 颜色也会保留。不根据文件后缀或输出文字猜测颜色，没有颜色信息的内容保持默认颜色。显式 `ls -1`、`ls -l`、`ls --color=never` 等选项优先。管道、重定向、变量展开和复合命令不注入列格式或颜色，以免改变命令处理的数据。

Windows 优先使用 `CLAUDE_CODE_GIT_BASH_PATH` 指定的 Bash，否则查找 Git for Windows 的常见安装目录，避免误用 WSL 的 `bash.exe`。

每条命令使用登录 Bash 加载 `/etc/profile` 和个人登录配置，再开启 alias 展开，因此可以使用配置中的 `ll` 等别名。通常由 `~/.bash_profile` 加载 `~/.bashrc`。加载配置后恢复本次工作目录，保持连续 `cd` 的行为。

每条命令使用独立 Bash 进程，执行结束后显示输出，最多运行十分钟。只保持工作目录，变量、函数等 Shell 状态不跨命令保持；交互式终端程序不适用。插件重载或会话切换后回到正常对话。

命令输出保留原始换行，制表符转换为空格，ANSI 颜色转换为原生 Text 样式；光标移动等控制序列会移除。每次输出最多显示 50,000 字符、200 行，超过限制会显示截断提示。控制台历史最多保留最近 50,000 字符、200 行，并限制颜色片段数量，超出时删除最旧的内容；关闭时保存这部分输出，再释放控制台的临时历史。

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
