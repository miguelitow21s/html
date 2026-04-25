$ErrorActionPreference = 'Stop'

$base = 'https://orwingqtwoqfhcogggac.supabase.co'
$apiBase = 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

function New-IdempotencyKey {
    return [guid]::NewGuid().ToString()
}

function Login-Supabase($email, $password) {
    $payload = @{ email = $email; password = $password } | ConvertTo-Json
    $resp = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anonKey; 'Content-Type' = 'application/json' } -Body $payload
    return $resp
}

function Invoke-Action($token, $endpoint, $action, $payload = @{}) {
    $bodyObj = @{ action = $action }
    foreach ($k in $payload.Keys) {
        $bodyObj[$k] = $payload[$k]
    }

    $json = $bodyObj | ConvertTo-Json -Depth 20
    $headers = @{
        apikey = $anonKey
        Authorization = "Bearer $token"
        'Content-Type' = 'application/json'
        'Idempotency-Key' = (New-IdempotencyKey)
    }

    $resp = Invoke-WebRequest -Method Post -Uri "$apiBase/$endpoint" -Headers $headers -Body $json -SkipHttpErrorCheck
    $body = $null
    if ($resp.Content) {
        try {
            $body = $resp.Content | ConvertFrom-Json -Depth 20
        } catch {
            $body = @{ raw = $resp.Content }
        }
    }

    return [pscustomobject]@{
        status = [int]$resp.StatusCode
        request_id = ($resp.Headers['X-Request-Id'] | Select-Object -First 1)
        body = $body
        ok = ([int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 300)
    }
}

function Get-Items($actionResp) {
    if (-not $actionResp -or -not $actionResp.body) {
        return @()
    }

    if ($actionResp.body.data -and $actionResp.body.data.items) {
        return @($actionResp.body.data.items)
    }

    if ($actionResp.body.data -is [System.Array]) {
        return @($actionResp.body.data)
    }

    if ($actionResp.body.items) {
        return @($actionResp.body.items)
    }

    return @()
}

function Ensure-LegalConsent($token) {
    $statusResp = Invoke-Action -token $token -endpoint 'legal_consent' -action 'status'
    if (-not $statusResp.ok) {
        return $statusResp
    }

    $accepted = $statusResp.body.data.accepted
    if ($accepted -eq $true) {
        return $statusResp
    }

    $termId = $statusResp.body.data.active_terms.id
    if (-not $termId) {
        return $statusResp
    }

    return Invoke-Action -token $token -endpoint 'legal_consent' -action 'accept' -payload @{ legal_terms_id = $termId }
}

$stamp = (Get-Date).ToString('yyyyMMddHHmmss')
$seedEmployeeEmail = "qa.empleado.$stamp@gmail.com"

Write-Output '=== LOGIN ==='
$adminSession = Login-Supabase -email 'admin@gmail.com' -password '123456'
$supervisorSession = Login-Supabase -email 'supervisora@gmail.com' -password '123456'
$employeeSession = Login-Supabase -email 'miguel@gmail.com' -password '123456'

Write-Output "admin_login_ok user=$($adminSession.user.email)"
Write-Output "supervisor_login_ok user=$($supervisorSession.user.email)"
Write-Output "employee_login_ok user=$($employeeSession.user.email)"

Write-Output '=== LEGAL CONSENT CHECK ==='
$null = Ensure-LegalConsent -token $adminSession.access_token
$null = Ensure-LegalConsent -token $supervisorSession.access_token
$null = Ensure-LegalConsent -token $employeeSession.access_token
Write-Output 'legal_consent_checked'

Write-Output '=== DIRECTORY LOOKUPS ==='
$supervisorList = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{ role = 'supervisora'; limit = 100 }
$employeeList = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{ role = 'empleado'; limit = 200 }

if (-not $supervisorList.ok) { throw "No se pudo listar supervisoras. status=$($supervisorList.status)" }
if (-not $employeeList.ok) { throw "No se pudo listar empleados. status=$($employeeList.status)" }

$supervisors = Get-Items $supervisorList
$employees = Get-Items $employeeList

$supervisorUser = $supervisors | Where-Object { $_.email -eq 'supervisora@gmail.com' } | Select-Object -First 1
$miguelEmployee = $employees | Where-Object { $_.email -eq 'miguel@gmail.com' } | Select-Object -First 1

if (-not $supervisorUser) { throw 'No se encontró supervisora@gmail.com en admin_users_manage list.' }
if (-not $miguelEmployee) { throw 'No se encontró miguel@gmail.com como empleado en admin_users_manage list.' }

Write-Output "supervisor_id=$($supervisorUser.id)"
Write-Output "miguel_employee_id=$($miguelEmployee.id)"

Write-Output '=== SEED EMPLOYEE (SECOND) ==='
$createEmployee = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'create' -payload @{
    email = $seedEmployeeEmail
    role = 'empleado'
    password = '123456'
    full_name = 'Empleado QA Seed'
    phone_number = '+573001112233'
    is_active = $true
}

$secondEmployeeId = $null
if ($createEmployee.ok) {
    $secondEmployeeId = $createEmployee.body.data.id
    if (-not $secondEmployeeId) { $secondEmployeeId = $createEmployee.body.data.user_id }
    if (-not $secondEmployeeId) { $secondEmployeeId = $createEmployee.body.data.created_user.id }
    Write-Output "seed_employee_created email=$seedEmployeeEmail id=$secondEmployeeId"
} else {
    Write-Output "seed_employee_create_failed status=$($createEmployee.status) request_id=$($createEmployee.request_id)"
}

# Always attempt recovery by email because create response shape can vary by environment.
if (-not $secondEmployeeId) {
    $employeeList2 = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{ role = 'empleado'; limit = 400 }
    $second = (Get-Items $employeeList2) | Where-Object { $_.email -eq $seedEmployeeEmail } | Select-Object -First 1
    if ($second) {
        $secondEmployeeId = $second.id
        Write-Output "seed_employee_recovered id=$secondEmployeeId"
    }
}

if (-not $secondEmployeeId) {
    throw 'No se pudo crear/recuperar segundo empleado semilla.'
}

Write-Output '=== CREATE RESTAURANTS (2) ==='
$restaurantA = Invoke-Action -token $adminSession.access_token -endpoint 'admin_restaurants_manage' -action 'create' -payload @{
    name = "QA Seed A $stamp"
    lat = 4.710989
    lng = -74.072090
    radius = 120
    address_line = 'Cra 7 # 32-16'
    city = 'Bogota'
    state = 'Cundinamarca'
    country = 'CO'
    is_active = $true
}
$restaurantB = Invoke-Action -token $adminSession.access_token -endpoint 'admin_restaurants_manage' -action 'create' -payload @{
    name = "QA Seed B $stamp"
    lat = 4.653332
    lng = -74.083652
    radius = 120
    address_line = 'Av Caracas # 45-20'
    city = 'Bogota'
    state = 'Cundinamarca'
    country = 'CO'
    is_active = $true
}

if (-not $restaurantA.ok) { throw "No se pudo crear restaurante A. status=$($restaurantA.status) request_id=$($restaurantA.request_id)" }
if (-not $restaurantB.ok) { throw "No se pudo crear restaurante B. status=$($restaurantB.status) request_id=$($restaurantB.request_id)" }

$restaurantAId = $restaurantA.body.data.restaurant_id
if (-not $restaurantAId) { $restaurantAId = $restaurantA.body.data.id }
$restaurantBId = $restaurantB.body.data.restaurant_id
if (-not $restaurantBId) { $restaurantBId = $restaurantB.body.data.id }

if (-not $restaurantAId -or -not $restaurantBId) {
    $listRestaurants = Invoke-Action -token $adminSession.access_token -endpoint 'admin_restaurants_manage' -action 'list' -payload @{ limit = 400 }
    $allRestaurants = Get-Items $listRestaurants
    if (-not $restaurantAId) {
        $matchA = $allRestaurants | Where-Object { $_.name -eq "QA Seed A $stamp" } | Select-Object -First 1
        if ($matchA) { $restaurantAId = $matchA.restaurant_id; if (-not $restaurantAId) { $restaurantAId = $matchA.id } }
    }
    if (-not $restaurantBId) {
        $matchB = $allRestaurants | Where-Object { $_.name -eq "QA Seed B $stamp" } | Select-Object -First 1
        if ($matchB) { $restaurantBId = $matchB.restaurant_id; if (-not $restaurantBId) { $restaurantBId = $matchB.id } }
    }
}

if (-not $restaurantAId -or -not $restaurantBId) {
    throw 'No se pudieron resolver los IDs de restaurantes semilla.'
}

Write-Output "restaurant_a_id=$restaurantAId"
Write-Output "restaurant_b_id=$restaurantBId"

Write-Output '=== ASSIGN SUPERVISOR + STAFF ==='
$assignSupA = Invoke-Action -token $adminSession.access_token -endpoint 'admin_supervisors_manage' -action 'assign' -payload @{ supervisor_id = $supervisorUser.id; restaurant_id = $restaurantAId }
$assignSupB = Invoke-Action -token $adminSession.access_token -endpoint 'admin_supervisors_manage' -action 'assign' -payload @{ supervisor_id = $supervisorUser.id; restaurant_id = $restaurantBId }
$assignMiguel = Invoke-Action -token $adminSession.access_token -endpoint 'restaurant_staff_manage' -action 'assign_employee' -payload @{ employee_id = $miguelEmployee.id; restaurant_id = $restaurantAId }
$assignSecond = Invoke-Action -token $adminSession.access_token -endpoint 'restaurant_staff_manage' -action 'assign_employee' -payload @{ employee_id = $secondEmployeeId; restaurant_id = $restaurantAId }

Write-Output "assign_sup_a_status=$($assignSupA.status)"
Write-Output "assign_sup_b_status=$($assignSupB.status)"
Write-Output "assign_miguel_status=$($assignMiguel.status)"
Write-Output "assign_second_status=$($assignSecond.status)"

Write-Output '=== SHIFT SCHEDULING TESTS (SUPERVISOR) ==='
$crossMidnight = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $miguelEmployee.id
    restaurant_id = $restaurantAId
    scheduled_start = '2026-04-14T01:00:00Z'
    scheduled_end = '2026-04-14T07:00:00Z'
    notes = 'QA cross-midnight seed'
}

$conflictShift = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $miguelEmployee.id
    restaurant_id = $restaurantAId
    scheduled_start = '2026-04-14T00:45:00Z'
    scheduled_end = '2026-04-14T04:00:00Z'
    notes = 'QA expected conflict'
}

$nonConflictShift = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $miguelEmployee.id
    restaurant_id = $restaurantAId
    scheduled_start = '2026-04-14T08:00:00Z'
    scheduled_end = '2026-04-14T11:00:00Z'
    notes = 'QA expected success'
}

$listShifts = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'list' -payload @{
    restaurant_id = $restaurantAId
    from = '2026-04-13T00:00:00Z'
    to = '2026-04-15T23:59:59Z'
    limit = 200
}

Write-Output "cross_midnight status=$($crossMidnight.status) request_id=$($crossMidnight.request_id)"
Write-Output "cross_midnight body=$([string]($crossMidnight.body | ConvertTo-Json -Depth 8 -Compress))"
Write-Output "conflict_shift status=$($conflictShift.status) request_id=$($conflictShift.request_id)"
Write-Output "conflict_shift body=$([string]($conflictShift.body | ConvertTo-Json -Depth 8 -Compress))"
Write-Output "non_conflict_shift status=$($nonConflictShift.status) request_id=$($nonConflictShift.request_id)"
Write-Output "non_conflict_shift body=$([string]($nonConflictShift.body | ConvertTo-Json -Depth 8 -Compress))"

$listedCount = 0
if ($listShifts.ok) {
    $listedCount = (Get-Items $listShifts).Count
}
Write-Output "list_shifts status=$($listShifts.status) count=$listedCount request_id=$($listShifts.request_id)"

Write-Output '=== SUMMARY ==='
Write-Output "seed_restaurants=$restaurantAId,$restaurantBId"
Write-Output "seed_employees=$($miguelEmployee.id),$secondEmployeeId"
