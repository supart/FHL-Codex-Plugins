# FHL Codex Plugins

给 Codex 用的 FHL 插件 marketplace。

当前已提供插件：`fhl-image-gen`

## 快速开始

直接执行下面两条命令即可添加 marketplace 并安装插件：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
codex plugin add fhl-image-gen@fhl-plugins
```

如果你已经添加过 marketplace，只需要执行第二条安装命令。

## 项目简介

这个仓库是一个 Codex Git marketplace，marketplace 名称是 `fhl-plugins`，展示名称是 `FHL Plugins`。

目前仓库里提供的插件是：

- `fhl-image-gen`：基于 FHL Responses API 的文生图 / 图生图插件，支持固定比例、批量生图、多参考图图生图、连续出图和自适应并发。

## 安装前准备

开始前请确认：

- 你已经安装并可以正常使用 Codex
- 你的网络可以访问 GitHub 和 FHL 服务
- 你已经准备好自己的 FHL API Key
- 你知道 API Key 只保存在本机，不要写进仓库或公开发到网上

## 如何添加 Marketplace

### 方式一：命令行安装

这是最直接的方式：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
```

添加完成后，Codex 会识别这个仓库里的 marketplace 配置，并注册 `fhl-plugins`。

### 方式二：在 Codex App 中添加

如果你更习惯界面操作，可以在 Codex 的插件管理界面中：

1. 打开插件或 marketplace 管理页面
2. 选择添加 marketplace
3. 选择从 GitHub 仓库添加
4. 填入仓库地址：`https://github.com/supart/FHL-Codex-Plugins`

添加成功后，你会看到 `FHL Plugins` 这个 marketplace。

## 如何安装插件

安装 `fhl-image-gen`：

```bash
codex plugin add fhl-image-gen@fhl-plugins
```

安装完成后，插件标识就是：

```text
fhl-image-gen@fhl-plugins
```

如果后续 marketplace 有更新，可以重新同步 marketplace 后再更新插件。

```bash
codex plugin marketplace upgrade fhl-plugins
```

## 首次配置 API Key

`fhl-image-gen` 需要先写入你自己的 FHL API Key。

### Windows PowerShell

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
```

### macOS / Linux / Git Bash

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --get-config
```

配置文件保存在本机：

```text
~/.codex/fhl-image-gen-config.json
```

`--get-config` 只会显示脱敏后的 key 预览，不会打印完整 API Key。看到 `hasKey: true` 就说明配置成功。

## 如何使用

安装完成后，你可以直接在 Codex 对话里让它用 FHL 出图，也可以手动运行脚本。

插件规则已经要求：只要出图成功，图片会立即返回到 Codex 对话框里，同时也会保存到本地。

默认保存目录：

```text
~/Pictures/fhl-image-gen
```

### 1. 文生图

最基础的文生图：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗"
```

指定比例：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --aspect 16:9
```

### 2. 同提示词多张

同一个提示词一次生成多张，`--count` 上限是 `9`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --count 9 --concurrency 3 --aspect 16:9
```

### 3. 连续出图 / 自适应并发

连续跑很多张时，用 `--repeat`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9
```

说明：

- `--repeat` 范围是 `1..50`
- 默认开启自适应并发
- 如果上游出现 `502 / 503 / 504 / 524 / rate limit / account busy` 这类可重试错误，插件会自动重试，并把后续任务降到 `concurrency=1`
- 目标是优先保证最终成功率，而不是硬顶并发

如果你明确不想启用自适应：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9 --no-adaptive
```

### 4. 多提示词批量生图

不同提示词可以直接内联批量：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch-inline "一只钓鱼的小猫" "一只看书的小狗" "一只晒太阳的小兔子"
```

也可以使用 JSON 文件：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch prompts.json
```

### 5. 单图图生图

图生图默认走 FHL Responses API，不走旧的 Images Edits 路线。

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --edit --image "C:\path\input.png" --prompt "把这张图改成 9:16 海报风格" --aspect 9:16
```

如果你想基于同一张参考图连续生成多个编辑版本，可以追加 `--count 1..4`。

### 6. 多参考图图生图

如果你想让多张参考图一起参与同一次生成，可以传多个 `--image`。插件会按顺序把它们作为多个 `input_image` 上传到同一个 Responses 请求里，不会先拼图。

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --edit --image "C:\path\one.png" --image "C:\path\two.png" --image "C:\path\three.png" --prompt "将这些玩具组合成一个在互相玩耍的场景，保留玩具质感和颜色风格" --aspect 16:9
```

当前批量图生图的源图数量上限是 `10` 张。

### 7. 按源图分别批量图生图

如果你不是想把多张图作为一组参考，而是想让每一张源图各自单独出图，可以显式使用 `--batch-edit`：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --batch-edit --edit --image "C:\path\one.png" --image "C:\path\two.png" --prompt "生成玩具海报图" --concurrency 3
```

## 支持的比例与尺寸

插件已经把支持比例固定下来，只允许使用已验证通过的比例。

支持的比例：

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

当前固定使用 2K 预设矩阵：

| 比例 | 对应尺寸 |
| --- | --- |
| 1:1 | 2048x2048 |
| 3:2 | 2048x1360 |
| 2:3 | 1360x2048 |
| 4:3 | 2048x1536 |
| 3:4 | 1536x2048 |
| 16:9 | 2048x1152 |
| 9:16 | 1152x2048 |
| 2:1 | 2048x1024 |
| 1:2 | 1024x2048 |
| 7:4 | 2208x1264 |
| 4:7 | 1264x2208 |

以下比例已经因为重复实测返回上游 `502` 被禁用，不允许在插件里随便重新打开：

- `5:4`
- `4:5`
- `3:1`
- `1:3`

## 能力与限制

这个插件当前的真实行为是：

- 文生图默认走 `POST https://www.fhl.mom/v1/responses`
- 图生图默认也走 `POST https://www.fhl.mom/v1/responses`
- 文本模型固定为 `gpt-5.5`
- 图片工具模型固定为 `gpt-image-2`
- 图生图使用 `input_text + input_image` 的 Responses 方式
- 多参考图图生图是多图上传，不是拼图，不走旧版 multipart Images API
- 不支持任意 `--size` 自定义，只允许 `--ratio` / `--aspect`
- 不提供 1K / 4K 切换，当前插件固定按已验证的 2K 比例矩阵请求

插件内同时保留下面这条提示，供你了解当前上游限制说明：

> 由于官方请求限制FHL只能接收1K图像，详细计费以后台为准。

如果你只是正常使用插件，可以直接理解为：当前版本已经把可用的比例、尺寸和请求方式都固化好了，按支持列表使用即可。

## 在 Codex 里怎么用

安装好插件并配置 API Key 后，最简单的方式就是直接在 Codex 对话里提出你的出图需求，例如：

- “用 FHL 出一张 16:9 的海边小狗照片”
- “用 FHL 把这张参考图改成竖版海报”
- “同一个提示词连续出 20 张，开启自适应并发”

插件命中后，会自动调用本地脚本，成功出图后会把图片直接显示在对话里。

如果你是刚安装完插件，当前线程里还没有正常触发，最稳的做法是新开一个 Codex 线程再使用。

如果你想检查插件配置是否正常，可先执行：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
```

## 基础排错

### 1. 安装 marketplace 失败

先确认仓库地址和命令是否正确：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
```

如果你是在公司网络或代理环境下，先确认 Codex 当前能访问 GitHub。

### 2. 插件安装失败

确认 marketplace 已经成功添加，然后重新执行：

```bash
codex plugin add fhl-image-gen@fhl-plugins
```

也可以先查看当前已添加的 marketplace 和插件，再判断是不是名称输错了。

### 3. `hasKey` 是 `false`

说明本机还没有写入可用的 FHL API Key，重新执行：

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --set-key "<你的FHL_API_KEY>"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
```

### 4. 提示比例不支持

这不是 bug，说明你传入了未开放或已禁用的比例。请只使用 README 里列出的支持比例。

### 5. 出图时报 502 / 503 / 504 / 524

这通常是 FHL 上游暂时不稳定。连续出图场景下，插件会自动重试并降级并发。单次失败时，稍后再试通常更稳。

### 6. 图生图失败

先确认：

- 图片路径存在且可读取
- 图片格式正常
- 你使用的是 `--edit`
- 你没有尝试走旧版 Images Edits 路线

这个插件已经把图生图链路固定在 Responses API 上，不建议再切回旧版编辑接口。

## 仓库与插件信息

- GitHub 仓库：[supart/FHL-Codex-Plugins](https://github.com/supart/FHL-Codex-Plugins)
- Marketplace 名称：`fhl-plugins`
- Marketplace 展示名：`FHL Plugins`
- 插件标识：`fhl-image-gen@fhl-plugins`
- 插件目录：`./plugins/fhl-image-gen`

如果你只想记住一句安装命令，就记这两行：

```bash
codex plugin marketplace add supart/FHL-Codex-Plugins
codex plugin add fhl-image-gen@fhl-plugins
```
