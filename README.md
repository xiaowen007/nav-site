共享导航（左侧导航栏 + AI 自动收录版）

以 `wwp86.cc.cd`（科技共享·智能多功能响应式导航）为主模板，参考 `kjgx.168668520.xyz` 的
27 分类结构，加入**左侧分类导航栏**；数据由独立 JSON 驱动，易编辑易管理；并新增
**AI 自动识别写入**功能：粘贴网址 → 免费大模型识别站点信息 → 自动生成导航卡片。

## 目录结构

```
nav-site/
├── index.html        # 导航主页（左侧栏 + 卡片网格 + 搜索）
├── admin.html        # AI 收录 / 手动管理面板
├── server.js         # 零依赖 Node 后端（静态服务 + AI 识别 + 写入）
├── config.example.json # AI 配置模板（复制为 config.json 使用；含 Key/密码不入库）
├── config.json       # 本地实际配置（已被 .gitignore 忽略，切勿上传）
├── package.json      # 零依赖，npm start 即可运行
├── LICENSE           # MIT
├── css/style.css
├── js/app.js         # 前端渲染逻辑（含访问统计埋点）
├── js/admin.js       # 管理面板逻辑
├── data/sites.json   # ★ 全部导航数据（分类 + 链接），直接编辑即可
└── uploads/          # 通过管理面板上传的图标（自动生成，可整体删除）
```

## 运行

需要 Node.js（已内置，无需安装依赖）：

```bash
cd nav-site
node server.js
```

启动后访问：
- 导航主页： http://localhost:8787
- 管理面板： http://localhost:8787/admin.html

> 端口可用环境变量覆盖：`PORT=9000 node server.js`

## 如何编辑 / 管理导航

### 方式一：直接改 JSON（最简单）
编辑 `data/sites.json`，结构如下：

```json
{
  "site": { "title": "科技共享导航", "subtitle": "...", "logo": "🌐", "footer": "..." },
  "categories": [
    {
      "id": "recommend",
      "name": "常用推荐",
      "icon": "⭐",
      "links": [
        { "name": "百度", "url": "https://www.baidu.com", "desc": "搜索引擎", "icon": "" }
      ]
    }
  ]
}
```

- 图标 `icon` 可留空，前端会自动抓取站点 favicon；也可填完整图片 URL。
- 新增分类：复制一个 `categories` 元素，改 `id`（英文，唯一）、`name`、`icon` 即可，
  左侧导航栏会自动出现。
- 改完保存，刷新页面即可生效（已加防缓存）。

### 方式二：管理面板（可视化 + AI 自动写）
打开 `admin.html`：
1. 在「免费大模型配置」填入 API 地址 / Key / 模型（见下），点保存即时生效。
2. 在「粘贴网址批量识别」粘贴若干网址（每行一个），点「识别并预览」。
3. 逐项核对名称/网址/简介/分类，勾选要收录的项，点「写入选中项」——
   卡片会自动追加（或按网址去重更新）到 `data/sites.json`。
4. 也支持「手动添加单条」。

### 管理面板功能清单（admin.html）
- **① 导航数据管理**：左侧分类可 ➕新增 / ✎重命名编辑 / 🗑删除、拖拽排序；右侧链接表格行内编辑、
  ↑↓ 或拖拽排序、✕删除、➕新增；改完点「💾 保存」整体写回 `sites.json`，并有未保存拦截与「⬇ 导出」备份。
- **② AI 自动识别写入**：粘贴网址 → 免费大模型识别 → 勾选写入（见下）。
- **③ 免费大模型配置 + 后台密码保护**：在线填 Key/接口/模型，或设置管理密码（启用后写操作需密码）。

### 图标：自动匹配 or 上传（二选一）
- **自动匹配**：链接「🪄」按钮——根据网址域名自动生成 favicon 地址
  （`https://icons.duckduckgo.com/ip3/<域名>.ico`）并写入，无需手动找图。
- **上传图标**：链接「⬆」按钮 或 分类编辑框里的「⬆ 上传图标」——选择本地图片，
  由后端 `POST /api/upload` 保存到 `uploads/` 并返回访问 URL，写入 `icon` 字段。
  支持 png/jpg/gif/webp/svg，单张 ≤ 2MB。
- `icon` 字段留空时，前台仍会自动回退到 favicon 服务显示，因此「不填也能用」。

### 链接访问统计
- 前台每次点击卡片，会向后端 `POST /api/visit`（按 url 匹配）累加该链接的 `visits` 并写回 `sites.json`。
- 管理面板链接表格新增「访问」列实时显示次数；工具条右上角显示「分类访问 / 总访问」汇总；
  「↧ 访问排序」按钮可将当前分类按访问量降序排列。
- 导出 `sites.json` 时访问量一并保留。

### 导入 / 导出 JSON
- **⬇ 导出**：把当前（含未保存修改的）内存数据下载为 `sites.json`，便于备份或迁移。
- **⬆ 导入**：选择本地 `sites.json` 文件，确认后整体覆盖写回（导入前建议先导出备份）。

## 接入免费 AI 大模型（导航卡片自动识别）

`server.js` 调用 **OpenAI 兼容的 Chat Completions 接口**，因此任何兼容的服务都可接入。
在 `config.example.json` 复制一份为 `config.json`（或直接在管理面板）配置三项：

| 字段 | 说明 | 免费示例 |
|------|------|----------|
| `AI_API_BASE` | 接口地址 | `https://api.siliconflow.cn/v1`（硅基流动） |
| `AI_API_KEY`  | API Key | 各平台注册免费获取 |
| `AI_MODEL`    | 模型名 | `Qwen/Qwen2.5-7B-Instruct`（硅基流动免费模型） |

常用免费 / 低门槛兼容平台：
- 硅基流动 SiliconFlow：注册送额度，含 Qwen / DeepSeek 等免费模型
- DeepSeek： `https://api.deepseek.com/v1` ，模型 `deepseek-chat`（新用户有免费额度）
- OpenRouter： `https://openrouter.ai/api/v1` ，含多个免费模型
- Groq： `https://api.groq.com/openai/v1` ，Llama 等模型免费额度

**未配置 Key 也能用**：系统会自动退化为「启发式识别」（抓取网页 title/描述/
favicon 并粗略归类），同样可一键写入。

## 部署说明
- 本地 / 内网：直接 `node server.js` 即可。
- 公网服务器：用 pm2 / systemd / Docker 守护 `node server.js`，反向代理 8787 端口。
- 纯静态托管（如 GitHub Pages）：`index.html` 与 `data/sites.json` 可直接静态访问，
  但 **AI 自动写入需要后端**，此时可用管理面板在本地写好后再上传 `sites.json`。

## 自定义风格
配色集中在 `css/style.css` 顶部的 `:root` CSS 变量（背景、主题色、侧栏宽度等），
改一处即可换肤。

---

## 上传到 GitHub（仓库托管）

本项目已整理为「开箱即传」的干净结构：`config.json`、运行时上传目录 `uploads/*`
已在 `.gitignore` 中忽略，只提交源码与数据。**切勿把含 Key / 密码的 `config.json` 推上仓库。**

### 方式一：命令行（推荐）

```bash
# 1) 进入项目目录
cd nav-site

# 2) 初始化仓库（若已克隆则跳过）
git init

# 3) 添加全部文件（.gitignore 已自动排除 config.json 和 uploads/*）
git add .

# 4) 首次提交
git commit -m "初始提交：科技共享导航站（左侧栏 + AI 自动收录）"

# 5) 关联远程仓库（把 <用户名>/<仓库名> 换成你自己的）
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git

# 6) 推送到 GitHub
git push -u origin main
```

推送后到 GitHub 仓库页面就能看到全部文件。若想更新内容，重复：

```bash
git add .
git commit -m "更新说明"
git push
```

### 方式二：GitHub 网页端（不装 git）

1. 在 GitHub 新建仓库（New repository），名称随意，选 **Public** 或 **Private**。
2. 进入仓库 → **Add file → Upload files**，把 `nav-site/` 下这些文件拖进去：
   `index.html`、`admin.html`、`server.js`、`config.example.json`、`package.json`、
   `LICENSE`、`README.md`、`css/`、`js/`、`data/`、`uploads/.gitkeep`（`.gitignore` 也可一起传）。
3. **不要**上传本地的 `config.json`（可能含 Key / 密码）。
4. 写提交信息后点 **Commit changes**。

> 注意：直接拖文件夹 GitHub 不会保留空目录，因此 `uploads/` 已在仓库中由 `.gitkeep` 占位；
> 其余目录均含文件，可正常上传。

### 别人的仓库克隆后会怎样

克隆下来没有 `config.json`，但 `server.js` 会自动使用默认值（空 Key、无密码保护），
直接 `npm start` 即可运行；需要自定义时把 `config.example.json` 复制为 `config.json` 再改。

---

## 部署到云端（对外公开访问）

GitHub 仅托管代码，要让别人通过网址访问需部署到支持 Node.js 的平台：

- **CloudStudio / 任意 Node 平台**：上传后运行 `node server.js`，平台暴露 8787 端口即可。
- **Railway / Render / Fly.io**：新建 Node 项目，构建命令留空、启动命令 `npm start`，
  自动读取 `package.json`，部署后获得公网网址。
- **纯静态托管（GitHub Pages / Vercel Static）**：`index.html` + `data/sites.json` 可直接静态访问，
  但 **AI 自动写入依赖后端**；可在本地用管理面板写好数据，再把 `data/sites.json` 一并上传即可。

---


