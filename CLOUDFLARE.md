# 部署到 Cloudflare（全栈 Serverless）

本项目已改造为**零服务器**架构：前端仍是静态文件，后端 API 改写为 Cloudflare Pages Functions，
数据存 **KV**、上传图片存 **R2**。后台管理 / AI 一键识别 / 访问统计在线上**全部可用**。

> 本地开发仍可用原来的 `node server.js`（读写本地文件）。线上才走 Functions + KV + R2。

## 一、前置准备

```bash
# 安装并登录 Cloudflare（需有 Cloudflare 账号）
npx wrangler login
```

## 二、创建存储（KV + R2）

```bash
# 1) KV 命名空间（保存导航数据 + 配置）
npx wrangler kv namespace create NAV_KV
#   输出形如：{ "kv_namespaces": [ { "binding": "NAV_KV", "id": "abcd1234..." } ] }
#   把 id 复制到 wrangler.toml 的 NAV_KV.id

# 2) R2 存储桶（保存上传的图标/图片）
npx wrangler r2 bucket create nav-site-uploads
```

> 绑定名必须分别是 `NAV_KV` 和 `NAV_R2`（代码里写死了）。桶名 `nav-site-uploads` 可改，但需同步改 wrangler.toml。
>
> **KV 命名空间 / R2 桶不需要在部署前就建好**：项目已支持「部署后手动绑定」——
> 即使绑定尚未添加，部署也能成功，首页以**只读种子数据**正常展示；待你在后台添加绑定后，
> 保存/配置/上传等写操作自动生效，数据持久化到 KV / R2。

## 三、部署（两种方式选其一）

### 方式 A：命令行直接部署（推荐首次验证）

```bash
npm install        # 安装 wrangler（devDependency）
npm run deploy     # = npx wrangler pages deploy .
```

按提示创建 Pages 项目即可。KV/R2 绑定取自 `wrangler.toml`。

### 方式 B：连接 GitHub 自动部署（推荐长期）

1. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → 连接 Git 仓库 `xiaowen007/nav-site`。
2. 构建设置：**Build command** 留空，**Build output directory** 填 `.`（点号，表示根目录）。
3. 直接部署即可（**无需预先绑定 KV/R2**）。此时网站以只读种子数据正常打开。
4. 部署后，进入项目 **Settings → Functions → KV namespace bindings**，添加：
   - 变量名 `NAV_KV` → 选你建的 KV 命名空间
5. 进入 **Settings → Functions → R2 buckets bindings**，添加：
   - 变量名 `NAV_R2` → 选 `nav-site-uploads`
6. 绑定保存后**无需重新部署**，刷新页面即生效（写操作立即变为可读写）。

> ⚠️ Git 连接方式下，绑定**不会**自动从 wrangler.toml 读取，必须在 Dashboard 里手动加（变量名一致即可）。
> 绑定前若调用保存/上传接口，会返回 `503` 并提示「存储未绑定：NAV_KV / NAV_R2」，属预期行为，绑定后即恢复正常。

## 四、首次访问与数据

- 首次打开网站时，Functions 会自动把当前 `data/sites.json`（已打包进种子 `functions/_seed.js`）写入 KV。
- 之后在**后台**（`/admin.html`）的增删改、排序、分类图标、访问统计都会持久化到 KV / R2。
- 想重新用本地 `data/sites.json` 覆盖线上数据：在后台点“导出 JSON”拿到最新数据，或清理 KV 键 `sites` 后重新访问即重新播种。

## 五、可选：用密钥保护配置（更安全）

后台“系统设置”里填的 `AI_API_KEY` / `ADMIN_PASSWORD` 会存进 KV。
若想用 Cloudflare Secrets（不落 KV），可：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put AI_API_KEY
```

环境变量(secrets)优先级高于 KV 中同名配置。

## 六、自定义域名

项目 **Settings → Custom domains** 中添加你的域名，按提示加 DNS 解析即可（免费 SSL）。

## 七、本地预览 Functions

```bash
npm run dev:cf     # npx wrangler pages dev .  （KV/R2 用本地模拟存储）
```

## 目录说明

```
functions/
  _lib.js            # 共享逻辑（config/数据/AI/工具）
  _seed.js           # KV 为空时的种子数据（来自 data/sites.json，勿手改）
  api/sites.js       # GET 读 / POST 全量保存
  api/save.js        # POST 单条 upsert
  api/recognize.js   # POST AI/启发式识别
  api/upload.js      # POST 上传图片 -> R2
  api/visit.js       # POST 访问统计
  api/config.js      # GET/POST 配置
  uploads/[name].js  # GET 从 R2 提供上传文件
wrangler.toml        # Pages + KV + R2 绑定配置
```
