# 打 App 安装包（Hana v2 App zip）
#
# 为什么用 git archive 而不用宿主的 /export 端点：
#   宿主导出会把**整个工作目录**打包——包含 .git/（历史 + 10MB pack）、
#   host-backups/（含用户真实数据备份）、docs/（内部方案）。
#   那种包不能对外发布。git archive 只取被跟踪的文件，天然排除
#   .gitignore 里的东西，且与某个 tag 逐字对应、可复现。
#
# 用法：
#   pwsh -File tools\export-release.ps1                  # 用 HEAD 当前版本
#   pwsh -File tools\export-release.ps1 -Ref v0.3.0      # 用某个 tag
#   pwsh -File tools\export-release.ps1 -Out D:\x.zip

param(
  [string]$Ref = "",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  if (-not $Ref) { $Ref = "HEAD" }

  # 版本号从 manifest 读，保证包名与包内声明一致
  $ver = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).version
  if (-not $Out) {
    $Out = Join-Path (Split-Path $root -Parent) ("eleckoi-tavern-v" + $ver + ".zip")
  }

  # 干净检查：有未提交改动时提醒（不是阻断——打 tag 的场景本来就要先提交）
  $dirty = (git status --porcelain)
  if ($dirty) {
    Write-Warning "工作树有未提交改动；git archive 取的是提交内容，工作区改动不会进包。"
  }

  Remove-Item $Out -Force -ErrorAction SilentlyContinue
  git archive --format=zip -o $Out $Ref
  if ($LASTEXITCODE -ne 0) { throw "git archive 失败（$Ref）" }

  # node_modules 不在 git 里，但运行依赖必须随包走——
  # 不然装上后 Edge 朗读直接报“依赖没装上”，用户还得手动 npm install。
  # 存在就全量塞入（目前全量才 ~3MB，比让用户装一次依赖便宜得多）。
  $nm = Join-Path $root "node_modules"
  if (Test-Path $nm) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::Open($Out, "Update")
    try {
      Get-ChildItem $nm -Recurse -File | ForEach-Object {
        $rel = "node_modules/" + $_.FullName.Substring($nm.Length + 1).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel) | Out-Null
      }
    } finally { $z.Dispose() }
    Write-Host "已塞入 node_modules（运行依赖随包走）"
  }

  $f = Get-Item $Out
  Write-Host ("已打包: " + $f.FullName)
  Write-Host ("版本: " + $ver + " · 来源: " + $Ref + " · 大小: " + [math]::Round($f.Length / 1KB, 1) + " KB")

  # 自检：manifest 在根 + 无 .git/host-backups/docs
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [System.IO.Compression.ZipFile]::OpenRead($Out)
  $names = $z.Entries | ForEach-Object { $_.FullName }
  $z.Dispose()
  if ($names -notcontains "manifest.json") { throw "包里没有 manifest.json（根目录）" }
  $junk = $names | Where-Object { $_ -match "^\.git/|^host-backups/|^docs/|^app-data/" }
  if ($junk) { throw ("包里混进了不该发的目录：" + ($junk | Select-Object -First 3 -Unique)) }

  # manifest 引用的静态文件在不在
  $missing = @()
  foreach ($p in @("manifest.json", "index.js", "assets/icon.png", "assets/cover.png", "ui/characters.html", "ui/rail.html")) {
    if ($names -notcontains $p) { $missing += $p }
  }
  # 运行依赖：msedge-tts 不在包里，Edge 朗读就是死路
  if ($names -notcontains "node_modules/msedge-tts/package.json") { $missing += "node_modules/msedge-tts/package.json" }
  if ($missing) { throw ("manifest 引用但包里缺：" + ($missing -join "、")) }

  Write-Host "自检通过：manifest 在根、无 .git/host-backups/docs、引用文件齐全"
}
finally {
  Pop-Location
}
