@echo off
REM 共享导航 - Cloudflare 一键部署（在本机、已联网、有 Cloudflare 账号的环境下运行）
REM 前置：需先 git push 把最新代码（含 functions/、wrangler.toml）推到 GitHub
title 共享导航 - Cloudflare 部署
cd /d %~dp0\..

echo [1/5] 安装 wrangler
call npm install

echo [2/5] 登录 Cloudflare（将打开浏览器授权）
call npx wrangler login

echo [3/5] 创建 KV 命名空间（保存导航数据+配置）
call npx wrangler kv namespace create NAV_KV

echo [4/5] 创建 R2 存储桶（保存上传图标）
call npx wrangler r2 bucket create nav-site-uploads

echo.
echo ============================================================
echo  请把上面 [3/5] 输出里的 "id" 复制到 wrangler.toml 的：
echo      [[kv_namespaces]]
echo      binding = "NAV_KV"
echo      id = "这里"
echo  然后保存文件，按任意键开始部署。
echo ============================================================
pause

echo [5/5] 部署到 Cloudflare Pages
call npm run deploy

echo.
echo 部署完成！在 Cloudflare 控制台 -> Pages 项目 -> Settings 可绑定自定义域名。
echo 若用 GitHub 连接部署（而非本命令），请务必在后台手动加 KV 绑定 NAV_KV 与 R2 绑定 NAV_R2。
pause
