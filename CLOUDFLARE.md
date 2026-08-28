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

### ⚠️ 重要：绑定由 `wrangler.toml` 管理，不在后台添加

本项目的 `wrangler.toml` 已包含 `pages_build_output_dir`，因此 Cloudflare Pages **以 wrangler.toml 为配置的唯一来源**（含绑定）。你会看到：

> Bindings for this project are being managed through wrangler.toml.

这意味着：

- **这是正常提示，不是错误**。后台的 KV / R2 绑定界面会被禁用，**不允许也无法**在那里添加绑定。
- 绑定必须（且已经）写在 `wrangler.toml` 的 `[[kv_namespaces]]` / `[[r2_buckets]]` 里。
- **KV 命名空间与 R2 桶本身必须先存在**（上面两条命令创建）。若 `wrangler.toml` 引用了账号里不存在的 KV id 或 R2 桶名，**部署会失败**。
- 绑定在**部署时**写入运行环境 → 改动 `wrangler.toml` 后**必须重新部署**才生效，刷新页面不会生效。

前提条件（必须同时满足，否则 wrangler.toml 会被当作"仅供本地开发"而忽略）：

- 使用 **V2 构建系统**（部署日志出现 `Using v2 root directory strategy` 即满足）
- Pages 使用的 Wrangler ≥ **3.45.0**（日志里有 `⛅️ wrangler 3.x`，本仓库已满足）
- **必须存在 `pages_build_output_dir`** 字段（本仓库已填 `.`）

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
3. 先按「二、创建存储」建好 KV 命名空间和 R2 桶，并把 KV id 填进 `wrangler.toml`。
4. 直接部署。**绑定随 `wrangler.toml` 一起生效，不需要（也不能）在后台添加**。
5. 想修改绑定 → 改 `wrangler.toml` 的 `id` / `bucket_name` → 提交推送 → **自动触发重新部署后生效**。

> ✅ Git 连接方式下，绑定**同样从 `wrangler.toml` 读取**，无需在 Dashboard 手动添加。
> 只有**没有** `wrangler.toml`（或其中没有 `pages_build_output_dir`）的项目，才需要在 Dashboard 的
> Settings → Functions 里手动添加绑定——那种情况下后台不会显示"managed through wrangler.toml"提示。
>
> 若 `wrangler.toml` 里的 KV id / 桶名在账号中不存在，部署会报错失败；
> 若引用正确但代码读到未绑定，写操作会返回 `503` 并提示「存储未绑定：NAV_KV / NAV_R2」。

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
- 报 `503 存储未绑定 NAV_KV` → 说明 `env.NAV_KV` 为空。按下面排查：
  1. 确认 `wrangler.toml` 里 `[[kv_namespaces]] binding = "NAV_KV"` 的 `id` 与 Cloudflare 后台 KV 列表里的**命名空间 id 完全一致**；
  2. 确认该 KV 命名空间确实在**同一个 Cloudflare 账号**下；
  3. 改过 `wrangler.toml` 后**必须重新部署**（Dashboard → Deployments → Redeploy，或 git push 触发）才会生效，刷新页面无效。
- 未绑 KV 却设了 env 密码 → 登录界面可能显示，但 `requireAuth` 因无 KV 直接放行，等于没保护；务必先让 KV 生效。
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

### 部署成功但后台保存不生效（真实踩过）
- 现象：后台 `/admin.html` 能打开、能改，但点「保存更改」报错或不生效；顶部出现红色横幅
  「⚠️ 存储未绑定 NAV_KV，保存不可用，请在 wrangler.toml 中配置绑定后重新部署」。
- 横幅出现即表示代码里 `env.NAV_KV` 为空（只读降级模式），按下面顺序排查：
  1. **看后台绑定界面是否显示** `Bindings for this project are being managed through wrangler.toml`
     - 显示了 → 绑定只能改 `wrangler.toml`，后台无法添加，**这是正常的**。
  2. 核对 `wrangler.toml`：`[[kv_namespaces]]` 的 `binding` 必须是 `NAV_KV`，`id` 必须与后台
     **Workers & Pages → KV** 列表里该命名空间的 id 完全一致（且在同一账号下）。
  3. 核对 `[[r2_buckets]]` 的 `bucket_name` 对应的桶**真实存在**（R2 → 桶列表）。桶不存在会导致部署失败。
  4. **改动 `wrangler.toml` 后必须重新部署**才生效：git push 自动触发，或 Dashboard → Deployments → **Redeploy**。
     刷新页面不会让新绑定生效。
  5. 重新部署成功后刷新 `/admin.html` → 横幅消失即表示 KV 已绑定，可正常保存。
- 只想让首页可浏览、暂不保存：未绑定 KV 时首页本就以只读种子数据正常展示，不影响访问。
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
