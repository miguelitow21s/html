$ErrorActionPreference = 'Stop'
$base = 'https://orwingqtwoqfhcogggac.supabase.co'
$api = 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

$admin = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon; 'Content-Type' = 'application/json' } -Body (@{ email = 'admin@gmail.com'; password = '123456' } | ConvertTo-Json)

function Act($ep, $act, $payload) {
    $h = @{
        apikey = $anon
        Authorization = "Bearer $($admin.access_token)"
        'Content-Type' = 'application/json'
        'Idempotency-Key' = [guid]::NewGuid().ToString()
    }

    $body = @{ action = $act }
    foreach ($k in $payload.Keys) {
        $body[$k] = $payload[$k]
    }

    $r = Invoke-WebRequest -Method Post -Uri "$api/$ep" -Headers $h -Body ($body | ConvertTo-Json -Depth 20) -SkipHttpErrorCheck
    $j = $r.Content | ConvertFrom-Json -Depth 20
    return @($j.data.items)
}

$users = Act 'admin_users_manage' 'list' @{ limit = 500 }
$qaUsers = $users | Where-Object { $_.email -like 'qa.empleado.*@gmail.com' -or $_.full_name -like '*QA*Seed*' }

$restaurants = Act 'admin_restaurants_manage' 'list' @{ limit = 200 }
$qaRestaurants = $restaurants | Where-Object { $_.name -like 'QA Seed*' }

Write-Output 'QA_USERS_JSON'
$qaUsers | Select-Object id, email, role, is_active, full_name | ConvertTo-Json -Depth 5
Write-Output 'QA_RESTAURANTS_JSON'
$qaRestaurants | Select-Object restaurant_id, id, name, is_active | ConvertTo-Json -Depth 5
