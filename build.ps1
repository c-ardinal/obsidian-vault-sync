$DEST_PATHS = @(
    "C:\_Workspace\obsidian\PluginTest\.obsidian\plugins\obsidian-vault-sync",
    "C:\_Workspace\obsidian\Dreamlands\.obsidian\plugins\obsidian-vault-sync"
)

Write-Host "=== STARTING TESTS ===" -ForegroundColor Cyan
# テスト実行 (エラーがあれば停止)
npx vitest run --reporter=verbose | Select-String "passed", "failed" -CaseSensitive
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests Failed! Aborting build." -ForegroundColor Red
    exit 1
}

Write-Host "=== STARTING BUILD ===" -ForegroundColor Cyan
# ビルド実行 (エラーがあれば停止)
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build Failed! Aborting copy." -ForegroundColor Red
    exit 1
}

Write-Host "=== COPYING FILES ===" -ForegroundColor Cyan
# ファイルコピー
foreach ($path in $DEST_PATHS) {
    if (-not (Test-Path $path)) {
        Write-Host "Creating destination directory: $path"
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }

    Copy-Item -Path ".\dist\obsidian-vault-sync\*" -Destination $path -Recurse -Force
    Write-Host "COPY DONE to: $path" -ForegroundColor Green
}