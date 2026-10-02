# 验证安装包可被宿主接受：stage → 检查 → discard（不真的装）
# 默认不指定 -Zip 时自动取 App 目录旁边最新的 eleckoi-tavern-v*.zip——
# 过去写死 v0.3.0 的旧路径，验的是历史包不是刚打的包（2026-10-02 修）。
param([string]$Zip = "")

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not $Zip) {
  $latest = Get-ChildItem (Split-Path $root -Parent) -Filter "eleckoi-tavern-v*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "没找到安装包——先跑 tools\export-release.ps1，或显式传 -Zip" }
  $Zip = $latest.FullName
}
$info = Get-Content "$env:USERPROFILE\.hanako\server-info.json" -Raw | ConvertFrom-Json
$port = $info.port; if (-not $port) { $port = $info.network.actualPort }
$base = "http://127.0.0.1:" + $port
$auth = @{ Authorization = "Bearer $($info.token)"; "Content-Type" = "application/json" }

if (-not (Test-Path $Zip)) { throw "包不存在: $Zip" }
$body = @{ kind = "app"; source = @{ type = "local"; path = $Zip } } | ConvertTo-Json -Depth 4

Write-Host "暂存安装（只解析，不落盘）…"
$r = Invoke-RestMethod -Uri ($base + "/api/extensions/install") -Method Post -Headers $auth -Body $body -TimeoutSec 300
Write-Host ("status=" + $r.status)
$st = $r.staged
if (-not $st) { throw ("宿主没返回 staged：" + ($r | ConvertTo-Json -Compress)) }
Write-Host ("stagedId=" + $st.stagedId)
Write-Host ("id=" + $st.id + "  version=" + $st.version + "  kind=" + $st.kind)
if ($st.warnings) { Write-Host ("警告：" + ($st.warnings -join "; ")) } else { Write-Host "无警告" }

Write-Host "丢弃暂存（不安装）…"
Invoke-RestMethod -Uri ($base + "/api/extensions/staged/" + $st.stagedId) -Method Delete -Headers $auth -TimeoutSec 60 | Out-Null
Write-Host "已丢弃。包可被宿主正确解析，未改动已装版本。"
