# FHL Codex Plugins

给 Codex 用的 FHL 插件 marketplace。

当前提供插件：`fhl-image-gen`

## 快速开始

先添加 marketplace，再安装插件：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
codex plugin add fhl-image-gen@fhl-plugins
```

如果你已经添加过 marketplace，只需要执行第二条安装命令。

## 项目简介

这个仓库是一个 Codex Git marketplace：

- marketplace 名称：`fhl-plugins`
- marketplace 展示名：`FHL Plugins`
- 当前插件：`fhl-image-gen@fhl-plugins`

`fhl-image-gen` 是一个基于 FHL Responses API 的 Codex 生图插件，支持：

- 文生图
- 单图图生图
- 多参考图图生图
- 同提示词多张
- 连续出图
- 最多 10 个独立 worker 的并行调度
- 通用 `workflow-batch-edit` 批量图生图工作流
- `preset nail-tryon` 预设
- 自动续跑、补洞和结果清单输出

## 安装前提

开始前请确认：

- 你已经安装并能正常使用 Codex
- 当前网络可以访问 GitHub 和 FHL 服务
- 你已经准备好自己的 FHL API Key
- API Key 只保存在本机，不写进仓库

## 添加 Marketplace

命令行方式：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
```

添加成功后，Codex 会识别仓库内的 `.agents/plugins/marketplace.json`，并注册 `fhl-plugins`。

## 安装插件

```bash
codex plugin add fhl-image-gen@fhl-plugins
```

安装完成后，插件标识就是：

```text
fhl-image-gen@fhl-plugins
```

如果 marketplace 后续有更新，可以刷新后再升级插件：

```bash
codex plugin marketplace upgrade fhl-plugins
```

## 首次配置 API Key

### 单个 Key

Windows PowerShell：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
```

macOS / Linux / Git Bash：

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --get-config
```

### 多个 Key / 多 worker

`v0.1.1` 开始支持 worker 池，最多可配置 10 个独立 API worker：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --add-worker-key "<KEY_2>" --worker-name worker-2
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --add-worker-key "<KEY_3>" --worker-name worker-3
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --list-workers
```

常用管理命令：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --list-workers
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --set-worker-key worker-2 "<NEW_KEY>"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --disable-worker worker-3
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --enable-worker worker-3
```

配置文件保存在本机：

```text
~/.codex/fhl-image-gen-config.json
```

`--get-config` 和 `--list-workers` 只显示脱敏后的 key 摘要，不会打印完整密钥。

## 使用方法

插件成功安装后，可以直接在 Codex 对话里让它调用 FHL 出图；也可以手动运行脚本。

默认输出目录：

```text
~/Pictures/fhl-image-gen
```

### 1. 文生图

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗"
```

指定比例：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --aspect 16:9
```

### 2. 同提示词多张

`--count` 上限是 `9`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --count 9 --concurrency 3 --aspect 16:9
```

### 3. 连续出图 / 自适应并发

`--repeat` 适合长任务，范围是 `1..50`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9
```

说明：

- 默认开启自适应并发
- 遇到 `429 / 502 / 503 / 504 / 524 / rate limit / account busy` 这类可重试错误时，会自动重试并对后续任务降速
- 优先保证整体成功率，而不是硬顶并发

强制关闭自适应：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9 --no-adaptive
```

### 4. 批量文生图

内联多提示词：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch-inline "一只钓鱼的小猫" "一只看书的小狗" "一只晒太阳的小兔子"
```

或使用 JSON 文件：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch prompts.json
```

### 5. 单图图生图

图生图默认固定走 Responses API：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --edit --image "C:\path\input.png" --prompt "把这张图改成 9:16 竖版海报" --aspect 9:16
```

### 6. 多参考图图生图

多张参考图会按顺序作为多个 `input_image` 一起上传到同一个 Responses 请求中，不会先拼图：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --edit --image "C:\path\one.png" --image "C:\path\two.png" --image "C:\path\three.png" --prompt "将这些参考图组合成一个完整场景，保留主要特征并生成高质量海报" --aspect 16:9
```

当前单次多参考图上传上限为 `10` 张。

### 7. 按源图分别批量图生图

如果你的需求是“每张源图各自出图”，而不是“多图合成一次请求”，显式使用 `--batch-edit`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch-edit --edit --image "C:\path\one.png" --image "C:\path\two.png" --prompt "为每张参考图生成独立海报" --concurrency 3
```

### 8. 通用批量图生图工作流

这是 `v0.1.1` 的重点能力。适合“固定参考图 + 一批变量图 + 多个场景模板”的生产任务，比如：

- 人物参考图 + 多个服装图
- 模特图 + 多个产品图
- 品牌参考图 + 多个商品图
- 角色参考图 + 多个道具图
- 家具图 + 多个空间图

用内联模板直接展开任务：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图目录>" --template-inline "保持固定参考图中的主体特征不变，将变量图内容自然融入场景，输出 9:16 竖构图" --template-inline "生成半身展示构图，突出变量图元素，主体身份不变" --aspect 9:16 --concurrency 6
```

也可以使用模板 JSON：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<固定参考图.png>" --item-dir "<变量图目录>" --templates templates.json --aspect 9:16 --concurrency 6
```

模板 JSON 结构示例：

```json
{
  "templates": [
    { "key": "closeup", "prompt": "保持人物特征不变，生成近景特写，突出变量图元素" },
    { "key": "poster", "prompt": "保持主体一致，生成完整海报构图，突出变量图元素" }
  ]
}
```

工作流特性：

- 每个变量图会展开为一个独立任务组
- 每个模板都是一次独立 Responses edit 请求
- 支持断点续跑
- 支持自动补洞
- 会输出 `manifest.json`、`summary.csv`、`failures.json`、`sessions.json`

### 9. `preset nail-tryon`

美甲试戴只是内置预设，不是插件唯一场景。需要时可以直接调用：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 20 --concurrency 10 --aspect 9:16
```

旧命令 `--nail-stress-test` 仍保留为兼容入口，但新任务更推荐使用通用 `--workflow-batch-edit`。

## 支持的比例与尺寸

插件当前固定为 2K 请求矩阵，只允许使用已验证可用的比例。

支持比例：

- `1:1`
- `3:2`
- `2:3`
- `4:3`
- `3:4`
- `16:9`
- `9:16`
- `2:1`
- `1:2`
- `7:4`
- `4:7`

别名：

- `square = 1:1`
- `landscape = 4:3`
- `portrait = 3:4`

2K 对应尺寸：

| 比例 | 尺寸 |
| --- | --- |
| `1:1` | `2048x2048` |
| `3:2` | `2048x1360` |
| `2:3` | `1360x2048` |
| `4:3` | `2048x1536` |
| `3:4` | `1536x2048` |
| `16:9` | `2048x1152` |
| `9:16` | `1152x2048` |
| `2:1` | `2048x1024` |
| `1:2` | `1024x2048` |
| `7:4` | `2208x1264` |
| `4:7` | `1264x2208` |

已禁用比例：

- `5:4`
- `4:5`
- `3:1`
- `1:3`

这些比例在真实 FHL 测试中多次返回上游 `502`，因此已经在插件里禁用，不允许再用 `--size` 自定义格式绕过。

## 能力与限制

当前真实行为如下：

- 文生图默认走 `POST https://www.fhl.mom/v1/responses`
- 图生图默认也走 `POST https://www.fhl.mom/v1/responses`
- 文本模型固定为 `gpt-5.5`
- 图像工具模型固定为 `gpt-image-2`
- 图生图使用 `input_text + input_image` 的 Responses 方式
- 多参考图图生图是多图上传，不是拼图
- 不支持任意 `--size` 自定义
- 当前插件固定按 2K 比例矩阵请求
- legacy Images API 编辑链路已禁用，不作为默认能力

插件内保留如下说明，便于理解当前上游限制：

> 由于官方请求限制FHL只能接收1K图像，详细计费以后台为准。

对普通使用者来说，可以直接理解为：当前版本已经把可用的比例、尺寸和请求方式固化好了，按支持列表使用即可。

## Worker 说明

`v0.1.1` 使用“单任务独占、独立任务并行”的 worker 池策略：

- 单次普通文生图：1 个任务，只占用 1 个 worker
- `--count` / `--repeat`：会拆成多个独立任务
- `--batch` / `--batch-inline`：每个提示词是 1 个独立任务
- `--batch-edit`：每张源图是 1 个独立任务
- `--workflow-batch-edit`：每个变量图 × 每个模板，都是 1 个独立任务
- 一个多参考图合成请求本身仍只占 1 个 worker，不会被拆烂

上限规则：

- worker 最多 10 个
- 总并发最多 10
- 只有存在多个独立任务时，多个 API 才会同时参与

## 基础排错

### 1. marketplace 添加失败

先确认仓库地址和命令正确：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
```

如果你在公司网络或代理环境下，先确认 Codex 能访问 GitHub。

### 2. 插件安装失败

确认 marketplace 已成功添加后，再执行：

```bash
codex plugin add fhl-image-gen@fhl-plugins
```

### 3. `hasKey` 是 `false`

说明本机还没有写入可用的 FHL API Key：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
```

### 4. 比例不支持

这不是 bug，而是你传入了未开放或已禁用的比例。请只使用 README 中列出的支持比例。

### 5. 出图时报 502 / 503 / 504 / 524

这通常是 FHL 上游暂时不稳定。连续任务下插件会自动重试、降速和补洞；单次失败时，稍后再试通常更稳。

### 6. 图生图失败

先确认：

- 图片路径存在且可读取
- 图片格式正常
- 你使用的是 `--edit`
- 你没有尝试切回 legacy Images API

## 仓库与插件信息

- GitHub 仓库：[supart/FHL-Codex-Plugins](https://github.com/supart/FHL-Codex-Plugins)
- marketplace 名称：`fhl-plugins`
- marketplace 展示名：`FHL Plugins`
- 插件标识：`fhl-image-gen@fhl-plugins`
- 插件目录：`./plugins/fhl-image-gen`
- 当前版本：`0.1.1`

如果你只想记住两条命令，就记这两行：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
codex plugin add fhl-image-gen@fhl-plugins
```
