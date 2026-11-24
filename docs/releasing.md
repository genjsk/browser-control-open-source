# 准备 GitHub 发布

## 上传源码

仓库根目录是这个文件夹。推荐名称 `browser-control`。将源码推送到自己的 GitHub 仓库；不要把旧项目、用户数据目录或整个桌面一起上传。

```sh
git init -b main
git add .
git commit -m "Initial open-source release"
git remote add origin <你的仓库地址>
git push -u origin main
```

`.gitignore` 已排除依赖、构建目录、exe、ZIP、测试报告和私人配置。提交前执行 `npm run prepare:release`，并检查 `git diff --cached --stat`。开启仓库的 private vulnerability reporting，再接受安全问题报告。

## 本地发布包

Windows x64 下运行：

```sh
npm ci --cache .local/npm-cache
python -m pip install -r requirements-build.txt
python scripts/build-gui.py
npm run package:portable
python scripts/build-installer.py
npm run package:source
```

将 `release/*.zip`、`release/*-setup.exe` 与对应的 `.sha256` 上传到 GitHub Releases。安装程序包含完整 Windows x64 便携包，可离线安装。本机临时构建位置在被 Git 忽略的 `.local`，不放进发布目录。

便携包由明确白名单构建，包含 `_internal`、Node.js、生产依赖和扩展；不包含 `.local`、浏览器配置或配对信息。发布脚本会审计这些内容。

## GitHub Actions

`ci.yml` 在 Windows、macOS 和 Linux 运行服务与迁移测试，并在 Windows 验证浏览器扩展。

`release.yml` 可手动构建测试产物；向仓库推送 `v*` 标签时构建、验证并发布 Windows x64 便携包与源码包。流程不在普通分支推送或 PR 上发布内容。例：

```sh
git tag v1.0.3
git push origin v1.0.3
```

标签前先更新 `package.json` 与锁文件版本、扩展版本及 `CHANGELOG.md`。Windows 正式分发建议由维护者按自己的发布身份添加代码签名；本项目未提供他人的证书或签名凭据。

## 移植验收

`python tests/release_smoke.py` 需要先构建便携包。它把完整包复制到带中文和空格的新位置，移除系统 Node.js 的 PATH，验证打包后的“接入 AI”、连接／断开／重启、默认目录、权限不足回退，以及实际迁移数据后保留配对并重新连接。`python tests/gui_storage.py` 验证设置按钮、取消后保持连接、缓存与设置迁移及旧目录清理。测试数据均放在工作区 `.local`，报告在 `test-results`。

这证明产物不依赖原始项目目录、开发环境 PATH 或现有配对信息，不能代替所有 Windows 版本、架构、企业策略和浏览器组合的实机验证。
