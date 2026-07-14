# Highpass Visual

Highpass Visual 是一个本地优先的 Codex 插件：把故事或文章编排为 Story Model、Beat、Shot 和图像规格，用 OpenCV 将 Selected Image 编译成频率层、GrabCut mask、轮廓、Distance Field 与 2.5D plates，再对相邻镜头编译 Homography、双向光流/遮挡置信度和轮廓对应，最后用确定性的 Canvas Shot/Transition Program 生成精确帧 MP4。

它可以做出优美的“绘制—显影—聚焦—蚀刻光”动画，但美感来自导演选择、图像质量、明暗层级与克制的 Treatment 共同作用；单独把高通结果全屏描边通常只会产生噪声。

## 本地依赖

- Node.js 20 或更高版本。
- Python 3.10 或更高版本；首次执行 `node scripts/setup-python.mjs` 会创建插件目录内的 `.venv`，并安装锁定版本的 NumPy 与 `opencv-contrib-python-headless`。
- FFmpeg 与 FFprobe，需要能从 `PATH` 运行。
- Google Chrome、Chromium 或 Microsoft Edge，用于确定性 Canvas 帧捕获。

安装 Python 环境后，在新 Codex 任务中先让 Skill 调用 `inspect_runtime`。只有 capability report 为 `ready` 时才承诺完整视频；缺少图像生成能力时，可以使用本地导入图像继续全流程。

## 本地安装

发布包是 `highpass-visual` 插件目录。把它放进一个本地 marketplace 的 `plugins/highpass-visual/`，让 marketplace entry 的 source 指向 `./plugins/highpass-visual`，然后执行：

```bash
codex plugin marketplace add /absolute/path/to/marketplace-root
codex plugin add highpass-visual@your-marketplace-name
```

重新安装或更新插件后，开启一个新的 Codex 任务，使新的 Skill 与 MCP tools 被重新载入。默认入口提示为：

```text
使用 $direct-story-films，把这段故事编排并制作成动画短片。
```

开发目录可运行：

```bash
npm ci
npm run python:setup
npm run validate
npm run package:plugin -- --output /absolute/output/highpass-visual
```

## 从故事到成片

1. `compile_director_project` 验证 Story Model、Beat、Shot、Image Candidate/Selection、连续性与逐镜头 direction hash。
2. Image Candidate 可来自 Codex image generation，也可直接导入本地文件。MCP 本身不调用第三方图像模型。
3. `compile_vision_asset` 一次性运行 OpenCV，输出 content-addressed Vision Asset。浏览器逐帧阶段不会重复运行 OpenCV。
4. `prepare_treatment_comparison` 在相同图像、seed、时长和视口下比较 Ink Reveal、Memory Focus、Etched Light；Shot Program 同时包含显著性相机与分层视差曲线。
5. `compile_transition_asset` 对相邻 Vision Assets 运行 ORB/RANSAC、Farneback 双向光流、前后向一致性、遮挡/光度置信度和轮廓对应，并按 Director intent 的质量门选择或降级。
6. `prepare_transition_program` 生成真正的双图 Cross Dissolve、Distance Field wipe、Homography dissolve、Optical Flow dissolve 或 Contour morph 预览。
7. `publish_story` 用共享重叠时间轴恢复 Shot/Transition PNG，避免重复 incoming head，裁齐音频/字幕，并输出 H.264 MP4、精确 Story frame manifest 与 Quality Evidence。

可直接从 `examples/director/the-signal/director-draft.json` 和导入图像 fixture 开始。`presets/` 提供横竖版 Delivery Profile 与三组 Vision Recipe；`schemas/mcp-tools.schema.json` 是当前 bundled MCP 对外输入/输出合同。

## 产物位置

所有大型结果写到调用时显式给出的 `outputRoot`，并按内容哈希分目录：Director Project、Vision Asset、预览、单 Shot frame manifest/PNG/MP4，以及最终 Story MP4/Quality Evidence。Shot/Transition Preview 会校验 Program、嵌入的子预览、HTML/runtime 与 OpenCV 转场栅格哈希，发布地址因此绑定实际像素实现。工具返回路径与摘要，不把图片或帧二进制塞进模型上下文。

## 安全与隐私

- MCP 只读取请求中给出的 draft、图像、mask、Vision manifest、Shot Program、preview、音频和字幕路径，以及本机运行时版本。
- MCP 只写入请求中给出的 artifact/output root；`setup-python.mjs` 另外写入插件自身的 `.venv`。
- OpenCV 编译、Canvas 捕获与 FFmpeg 发布不上传素材。预览使用 CSP，发布浏览器会阻止非本地网络请求。
- 若 Skill 通过 Codex image generation 生成 Image Candidate，该外部调用必须由当前 Codex 环境明确执行；它不属于本地 MCP 管线。
- Shot ID 不直接用于文件路径；发布目录使用哈希段，避免目录穿越。

## 能力边界

当前正式 renderer 是确定性 Canvas 2D；WebGL2 只作为能力报告中的可选加速，不影响规范出帧。2.5D 是 GrabCut/显式 mask + TELEA 补洞产生的分层视差，不宣称单目真实深度。人物口型/骨骼动画、生成式帧插值、自动配音配乐、云端 MCP 和自动审美批准仍不在范围。OpenCV 提供结构化视觉证据，不负责理解剧情，也不是通用语义分割模型。
