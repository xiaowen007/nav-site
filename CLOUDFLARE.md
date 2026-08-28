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

## 设置后台管理员密码

后台 `/admin.html` 需要账号密码才能登录（关闭了开放后台）。密码保护**真正生效的前提是先绑定 `NAV_KV`**——代码里未绑定 KV 时 `requireAuth` 直接放行（开放只读），此时设了密码也不会被校验，只是写操作会返回 503。

### 方式一：首次打开后台初始化（推荐）
1. 浏览器打开 `https://你的域名/admin.html`。
2. 全新部署时 KV 里还没有密码，`GET /api/auth` 返回 `configured:false`，页面自动弹出「初始化管理员账号」界面。
3. 填：管理员账号（≥2 字符，如 `admin`）、密码（≥6 位）、确认密码。
4. 确定 → `POST /api/auth/setup` 把账号密码写入 KV；之后用该账号密码登录，可勾选「记住 7 天」。

### 方式二：用 Cloudflare 环境变量 / Secret 预设（不用走初始化）
- Cloudflare Dashboard → 项目 **Settings → Variables and Secrets**（或 Functions 变量）添加：
  - `ADMIN_USER`（明文变量，如 `admin`）
  - `ADMIN_PASSWORD`（**设为 Secret 类型**，值填密码）
- 代码中 `env.ADMIN_PASSWORD` 优先级**高于** KV 中存的密码，设好即生效，直接登录即可；可随时轮换 Secret 而不动代码。详见下一节。

### 方式三：登录后在后台改密码
已登录后，后台顶栏「👤 账号」区可改密码（保存到 KV，同样要求 `NAV_KV` 已绑定）。

### 常见坑
- 没绑 `NAV_KV` 就点初始化 → 报 `503 存储未绑定 NAV_KV`，先去后台绑定再试。
- 未绑 KV 却设了 env 密码 → 登录界面可能显示，但 `requireAuth` 因无 KV 直接放行，等于没保护；务必先绑 KV。
- `env` 密码与初始化密码并存时，env 优先，登录用 env 那套。
- 账号 < 2 字符或密码 < 6 位 → 初始化被拒（400）。

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

## 八、更新代码后重新部署 & 常见问题排查

### 更新代码后如何触发新部署
- **方式 B（GitHub 连接）**：Cloudflare 在每次 `git push` 到 `main` 后**自动重新构建部署**。流程：本地改完 → `git push` → 在 Dashboard → Deployments 看新构建进度/日志，跑完即上线。
- 代码没变却想重跑：Dashboard → Deployments 点 **Redeploy** 手动触发。
- ⚠️ 部署拉的是**远程仓库最新提交**。本地改了没 `push`，Cloudflare 拉不到。提交前用 `git status` / `git log` 确认本地与远程 tip 一致。

### 部署报错 Failed building Pages Functions（两个真实踩过的坑）
**坑 A：同层文件与目录不能同名**
- 现象：`Failed building Pages Functions` / `generating Pages Functions failed`，日志无明显模块错误。
- 根因：Cloudflare Pages Functions 硬限制——`functions/api/` 下**文件与目录不能同名**。如同时存在 `functions/api/auth.js`（文件）和 `functions/api/auth/`（目录）会直接失败。
- 修复：合并为目录入口，把 `auth.js` 改为 `functions/api/auth/index.js`（保留 `GET /api/auth`），并删除原 `auth.js`。
- 排查：`find functions -name '*.js' | sed 's#/[^/]*$##' | sort -u` 列出所有目录，再 `ls functions/api` 看是否有同名 `.js` 文件。

**坑 B：共享模块 `_lib.js` 的相对 import 路径层级**
- 现象：`Could not resolve "../../../_lib.js"`（或 `../../_lib.js`），esbuild 打包阶段报多个错误。
- 根因：共享逻辑在 `functions/_lib.js`。Functions 内各文件引用它的相对路径，**`../` 的层数必须等于「该文件所在目录 → functions/ 的层数」**，多一级或少一级都找不到：
  - `functions/api/X.js` → `../_lib.js`（api→functions 一级）
  - `functions/api/auth/X.js` → `../../_lib.js`（auth→api→functions 两级）
  - `functions/api/auth/sub/X.js` → `../../../_lib.js`（三级，以此类推）
  - `functions/uploads/X.js` → `../_lib.js`（uploads→functions 一级）
- 注意：`node --check` 只校验语法，**发现不了**路径层级错误；必须用 `node` 实际 `import()` 该文件才能验证。
- 修复：按上表把对应层级的 `../` 数量改对即可。

### 部署成功但首页异常
- 若提示「存储未绑定：NAV_KV / NAV_R2」→ 属预期（未绑定 KV/R2 时写操作返回 503），按「方式 B 第 4–5 步」到后台绑定即可，绑定后刷新生效、无需重新部署。
- 若已绑定仍 503 → 检查变量名是否**完全为** `NAV_KV` / `NAV_R2`。
- 其他异常先看 Dashboard → Logs / 部署日志。

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
  api/auth/          # 鉴权子目录：index(状态)/login/logout/setup/verify
  uploads/[name].js  # GET 从 R2 提供上传文件
wrangler.toml        # Pages + KV + R2 绑定配置
```
