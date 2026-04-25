$ErrorActionPreference='Stop'
$base='https://orwingqtwoqfhcogggac.supabase.co'
$api='https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anon='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

function Act($tok,$ep,$act,$payload){
  $headers=@{apikey=$anon;Authorization="Bearer $tok";'Content-Type'='application/json';'Idempotency-Key'=[guid]::NewGuid().ToString()}
  $body=@{action=$act}
  foreach($k in $payload.Keys){$body[$k]=$payload[$k]}
  $resp=Invoke-WebRequest -Method Post -Uri "$api/$ep" -Headers $headers -Body ($body|ConvertTo-Json -Depth 20) -SkipHttpErrorCheck
  [pscustomobject]@{status=[int]$resp.StatusCode;request_id=($resp.Headers['X-Request-Id']|Select-Object -First 1);body=$resp.Content}
}

$admin=Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{apikey=$anon;'Content-Type'='application/json'} -Body (@{email='admin@gmail.com';password='123456'}|ConvertTo-Json)
$sup=Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{apikey=$anon;'Content-Type'='application/json'} -Body (@{email='supervisora@gmail.com';password='123456'}|ConvertTo-Json)

$ul=Act $admin.access_token 'admin_users_manage' 'list' @{role='empleado';limit=500}
$users=(($ul.body|ConvertFrom-Json -Depth 20).data.items)
$seed=$users | Where-Object { $_.email -like 'qa.empleado.*@gmail.com' -and $_.is_active -eq $true } | Sort-Object email -Descending | Select-Object -First 1
if(-not $seed){ throw 'No seed employee found.' }

$employeeId=$seed.id
$restaurantId=14
Write-Output "SEED employee_id=$employeeId email=$($seed.email) restaurant_id=$restaurantId"

$cross=Act $sup.access_token 'scheduled_shifts_manage' 'assign' @{employee_id=$employeeId;restaurant_id=$restaurantId;scheduled_start='2026-04-14T01:00:00Z';scheduled_end='2026-04-14T07:00:00Z';notes='qa clean cross'}
$overlap=Act $sup.access_token 'scheduled_shifts_manage' 'assign' @{employee_id=$employeeId;restaurant_id=$restaurantId;scheduled_start='2026-04-14T00:45:00Z';scheduled_end='2026-04-14T04:00:00Z';notes='qa clean overlap'}
$after=Act $sup.access_token 'scheduled_shifts_manage' 'assign' @{employee_id=$employeeId;restaurant_id=$restaurantId;scheduled_start='2026-04-14T08:00:00Z';scheduled_end='2026-04-14T11:00:00Z';notes='qa clean non-overlap'}

Write-Output "CROSS status=$($cross.status) request_id=$($cross.request_id)"
Write-Output "CROSS body=$($cross.body)"
Write-Output "OVERLAP status=$($overlap.status) request_id=$($overlap.request_id)"
Write-Output "OVERLAP body=$($overlap.body)"
Write-Output "AFTER status=$($after.status) request_id=$($after.request_id)"
Write-Output "AFTER body=$($after.body)"
