# 发布红线（每次会话必须遵守）

1. **版本号必须由人明确给出**：没有得到用户明确指定的版本号之前，禁止修改
   `package.json.version`、禁止 `npm version`、禁止打 `v*` tag。
2. **禁止本地 `npm publish` / `pnpm publish` / `yarn publish`**。本仓库的 npm
   发布只由 CI 完成：推送 `vX.Y.Z` tag 后自动触发。
3. 发版顺序固定为：
   - 用户明确版本号
   - 更新 `package.json` / `package-lock.json` / `CHANGELOG.md` / README 安装版本
   - `npm test` + `npm run pack:check`
   - 提交 `chore: release X.Y.Z`
   - 打 annotated tag `vX.Y.Z`
   - `git push origin main` 和 `git push origin vX.Y.Z`
   - 等 CI 发布，不要手动 publish
4. 用户只说“提交”“发版”但没给版本号时，先问版本号；不要自行推断。

5. 可选：`scripts/release.sh <version> [--dry-run] [--no-push]` 固化上述顺序；
   脚本只 bump/commit/tag/push，不执行 `npm publish`。不强制所有人使用。
