# ============================================================================
#  deploy.ps1 — one-shot: link project, push schema, load seed content,
#  and write the app's root .env. Reads secrets from .env.deploy (git-ignored).
#
#  Run it:   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#  (or just tell Claude "go" and it runs this for you.)
#
#  Safe to re-run. Secret values are never printed.
# ============================================================================

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# --- 1. Load .env.deploy into a hashtable -----------------------------------
$envFile = Join-Path $PSScriptRoot ".env.deploy"
if (-not (Test-Path $envFile)) {
  Write-Host "ERROR: .env.deploy not found. Fill it in first." -ForegroundColor Red
  exit 1
}
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $i = $t.IndexOf("=")
  if ($i -lt 1) { continue }
  $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

function Need($key) {
  if (-not $cfg.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($cfg[$key])) {
    Write-Host "ERROR: '$key' is empty in .env.deploy" -ForegroundColor Red
    exit 1
  }
  return $cfg[$key]
}

$ref     = Need "SUPABASE_PROJECT_REF"
$dbpass  = Need "SUPABASE_DB_PASSWORD"
$token   = Need "SUPABASE_ACCESS_TOKEN"
$url     = Need "SUPABASE_URL"
$anon    = Need "SUPABASE_ANON_KEY"
$service = Need "SUPABASE_SERVICE_ROLE_KEY"

# --- 2. Write the app's client env (public values only) ---------------------
Write-Host "==> Writing root .env (client: URL + anon)..." -ForegroundColor Cyan
"VITE_SUPABASE_URL=$url`nVITE_SUPABASE_ANON_KEY=$anon`n" |
  Set-Content -Path (Join-Path $PSScriptRoot ".env") -Encoding utf8 -NoNewline

# --- 3. Authenticate (token in env => no browser login needed) --------------
$env:SUPABASE_ACCESS_TOKEN = $token
$env:SUPABASE_DB_PASSWORD  = $dbpass   # makes link/push non-interactive

# --- 4. Link to the cloud project -------------------------------------------
Write-Host "==> Linking project $ref ..." -ForegroundColor Cyan
npx --yes supabase link --project-ref $ref
if ($LASTEXITCODE -ne 0) { Write-Host "Link failed." -ForegroundColor Red; exit 1 }

# --- 5. Push all migrations (0001..00xx) to the cloud DB --------------------
Write-Host "==> Pushing migrations (supabase db push)..." -ForegroundColor Cyan
"Y" | npx --yes supabase db push
if ($LASTEXITCODE -ne 0) { Write-Host "db push failed." -ForegroundColor Red; exit 1 }

# --- 6. Load seed content (service-role; never touches the browser) ---------
Write-Host "==> Seeding content..." -ForegroundColor Cyan
$env:SUPABASE_URL              = $url
$env:VITE_SUPABASE_URL         = $url
$env:SUPABASE_SERVICE_ROLE_KEY = $service
$env:SERVICE_ROLE_KEY          = $service
npm run seed:validate
if ($LASTEXITCODE -ne 0) { Write-Host "seed:validate failed (fix content, re-run)." -ForegroundColor Red; exit 1 }
npm run seed
if ($LASTEXITCODE -ne 0) { Write-Host "seed failed." -ForegroundColor Red; exit 1 }

# --- 7. Tidy: drop the access token from this session -----------------------
$env:SUPABASE_ACCESS_TOKEN = $null
$env:SUPABASE_DB_PASSWORD  = $null

Write-Host ""
Write-Host "DONE. Schema pushed + content seeded + root .env written." -ForegroundColor Green
Write-Host "Next: run 'npm run dev' and open http://localhost:5173/" -ForegroundColor Green
