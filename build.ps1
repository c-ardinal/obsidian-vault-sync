$DEST_PATH = "C:\_Workspace\obsidian\Dreamlands\.obsidian\plugins\obsidian-vault-sync"

Write-Host "=== STARTING TESTS ===" -ForegroundColor Cyan
# テスト実行 (エラーがあれば停止)
npx vitest run --reporter=verbose | Select-String "passed", "failed"
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Tests Failed! Aborting build." -ForegroundColor Red
    exit 1
}

Write-Host "=== STARTING BUILD ===" -ForegroundColor Cyan
# ビルド実行 (エラーがあれば停止)
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build Failed! Aborting copy." -ForegroundColor Red
    exit 1
}

Write-Host "=== COPYING FILES ===" -ForegroundColor Cyan
# ファイルコピー
if (-not (Test-Path $DEST_PATH)) {
    Write-Host "Creating destination directory: $DEST_PATH"
    New-Item -ItemType Directory -Force -Path $DEST_PATH | Out-Null
}

Copy-Item -Path ".\dist\*" -Destination $DEST_PATH -Recurse -Force
Write-Host "✅ COPY DONE to: $DEST_PATH" -ForegroundColor Green