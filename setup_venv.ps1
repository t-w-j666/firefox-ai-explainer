$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "requirements.txt")) {
    Write-Error "未找到 requirements.txt，请在 firefox-ai-explainer 根目录运行。"
}

python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\pip.exe install -r requirements.txt

Write-Host "完成。激活: .\.venv\Scripts\Activate.ps1"
