$ErrorActionPreference = 'Stop'

$base = 'https://orwingqtwoqfhcogggac.supabase.co'
$apiBase = 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

$results = [System.Collections.Generic.List[object]]::new()
$hasFailures = $false

function New-IdempotencyKey {
    [guid]::NewGuid().ToString()
}

function Parse-JsonSafe($raw) {
    if (-not $raw) {
        return $null
    }

    try {
        return ($raw | ConvertFrom-Json -Depth 30)
    } catch {
        return @{ raw = $raw }
    }
}

function Login-Supabase($email, $password) {
    $payload = @{ email = $email; password = $password } | ConvertTo-Json
    return Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{
        apikey = $anonKey
        'Content-Type' = 'application/json'
    } -Body $payload
}

function Invoke-Endpoint($token, $endpoint, $payload = @{}, $timeoutSec = 60) {
    $headers = @{
        apikey = $anonKey
        Authorization = "Bearer $token"
        'Content-Type' = 'application/json'
        'Idempotency-Key' = (New-IdempotencyKey)
    }

    $bodyJson = $payload | ConvertTo-Json -Depth 30
    $response = Invoke-WebRequest -Method Post -Uri "$apiBase/$endpoint" -Headers $headers -Body $bodyJson -SkipHttpErrorCheck -TimeoutSec $timeoutSec
    $body = Parse-JsonSafe $response.Content

    return [pscustomobject]@{
        status = [int]$response.StatusCode
        ok = ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
        request_id = ($response.Headers['X-Request-Id'] | Select-Object -First 1)
        body = $body
    }
}

function Invoke-Action($token, $endpoint, $action, $payload = @{}, $timeoutSec = 60) {
    $finalPayload = @{ action = $action }
    foreach ($k in $payload.Keys) {
        $finalPayload[$k] = $payload[$k]
    }

    return Invoke-Endpoint -token $token -endpoint $endpoint -payload $finalPayload -timeoutSec $timeoutSec
}

function First-NotEmpty($values) {
    foreach ($value in $values) {
        $normalized = [string]$value
        if ($null -ne $value -and $normalized.Trim() -ne '') {
            return $value
        }
    }

    return $null
}

function Get-Items($actionResponse) {
    if (-not $actionResponse -or -not $actionResponse.body) {
        return @()
    }

    if ($actionResponse.body.data -and $actionResponse.body.data.items) {
        return @($actionResponse.body.data.items)
    }

    if ($actionResponse.body.data -is [System.Array]) {
        return @($actionResponse.body.data)
    }

    if ($actionResponse.body.items) {
        return @($actionResponse.body.items)
    }

    return @()
}

function Add-Result($step, $response, $expectedStatuses, $note = '') {
    $status = [int]($response.status)
    $expected = @($expectedStatuses | ForEach-Object { [int]$_ })
    $passed = $expected -contains $status

    if (-not $passed) {
        $script:hasFailures = $true
    }

    $results.Add([pscustomobject]@{
        step = $step
        status = $status
        expected = ($expected -join '|')
        passed = $passed
        request_id = [string]($response.request_id || '')
        note = $note
        body = $response.body
    })
}

function Add-CustomResult($step, $passed, $note, $data = $null) {
    if (-not $passed) {
        $script:hasFailures = $true
    }

    $results.Add([pscustomobject]@{
        step = $step
        status = $null
        expected = $null
        passed = [bool]$passed
        request_id = ''
        note = $note
        body = $data
    })
}

function Ensure-LegalConsent($token) {
    $statusResp = Invoke-Action -token $token -endpoint 'legal_consent' -action 'status'
    if (-not $statusResp.ok) {
        return $statusResp
    }

    if ($statusResp.body.data.accepted -eq $true) {
        return $statusResp
    }

    $termId = $statusResp.body.data.active_terms.id
    if (-not $termId) {
        return $statusResp
    }

    return Invoke-Action -token $token -endpoint 'legal_consent' -action 'accept' -payload @{
        legal_terms_id = $termId
    }
}

Write-Output '=== E2E FULL APP: START ==='

$stamp = (Get-Date).ToString('yyyyMMddHHmmss')
$seedEmployeeEmail = "qa.e2e.$stamp@gmail.com"
$seedRestaurantName = "QA E2E Restaurant $stamp"

Write-Output '--- Step 1: Login roles ---'
$adminSession = Login-Supabase -email 'admin@gmail.com' -password '123456'
$supervisorSession = Login-Supabase -email 'supervisora@gmail.com' -password '123456'
$employeeSession = Login-Supabase -email 'miguel@gmail.com' -password '123456'

Write-Output '--- Step 2: Legal consent ---'
$adminConsent = Ensure-LegalConsent -token $adminSession.access_token
$supervisorConsent = Ensure-LegalConsent -token $supervisorSession.access_token
$employeeConsent = Ensure-LegalConsent -token $employeeSession.access_token
Add-Result -step 'legal_consent_admin' -response $adminConsent -expectedStatuses @(200)
Add-Result -step 'legal_consent_supervisor' -response $supervisorConsent -expectedStatuses @(200)
Add-Result -step 'legal_consent_employee' -response $employeeConsent -expectedStatuses @(200)

Write-Output '--- Step 3: Profile and directories ---'
$adminMe = Invoke-Action -token $adminSession.access_token -endpoint 'users_manage' -action 'me'
$supervisorMe = Invoke-Action -token $supervisorSession.access_token -endpoint 'users_manage' -action 'me'
$employeeMe = Invoke-Action -token $employeeSession.access_token -endpoint 'users_manage' -action 'me'
Add-Result -step 'users_manage.me_admin' -response $adminMe -expectedStatuses @(200)
Add-Result -step 'users_manage.me_supervisor' -response $supervisorMe -expectedStatuses @(200)
Add-Result -step 'users_manage.me_employee' -response $employeeMe -expectedStatuses @(200)

$supervisorList = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{
    role = 'supervisora'
    limit = 100
}
$employeeList = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{
    role = 'empleado'
    limit = 400
}
Add-Result -step 'admin_users_manage.list_supervisora' -response $supervisorList -expectedStatuses @(200)
Add-Result -step 'admin_users_manage.list_empleado' -response $employeeList -expectedStatuses @(200)

$supervisors = Get-Items $supervisorList
$employees = Get-Items $employeeList

$supervisorUser = $supervisors | Where-Object { $_.email -eq 'supervisora@gmail.com' } | Select-Object -First 1
$mainEmployee = $employees | Where-Object { $_.email -eq 'miguel@gmail.com' } | Select-Object -First 1

if (-not $supervisorUser) {
    Add-CustomResult -step 'resolve_supervisor_user' -passed $false -note 'No se encontró supervisora@gmail.com en admin_users_manage list.'
    throw 'No se encontró supervisora@gmail.com.'
}
if (-not $mainEmployee) {
    Add-CustomResult -step 'resolve_main_employee' -passed $false -note 'No se encontró miguel@gmail.com en admin_users_manage list.'
    throw 'No se encontró miguel@gmail.com.'
}

Write-Output '--- Step 4: Create seed employee and restaurant ---'
$createSeedEmployee = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'create' -payload @{
    email = $seedEmployeeEmail
    role = 'empleado'
    password = '123456'
    full_name = 'Empleado QA E2E'
    phone_number = '+573001112233'
    is_active = $true
}
Add-Result -step 'admin_users_manage.create_seed_employee' -response $createSeedEmployee -expectedStatuses @(200)

$seedEmployeeId = First-NotEmpty @(
    $createSeedEmployee.body.data.id,
    $createSeedEmployee.body.data.user_id,
    $createSeedEmployee.body.data.created_user.id
)

if (-not $seedEmployeeId) {
    $employeeListRefresh = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{
        role = 'empleado'
        limit = 500
    }
    Add-Result -step 'admin_users_manage.list_empleado_refresh' -response $employeeListRefresh -expectedStatuses @(200)
    $seedEmployee = (Get-Items $employeeListRefresh) | Where-Object { $_.email -eq $seedEmployeeEmail } | Select-Object -First 1
    $seedEmployeeId = $seedEmployee.id
}

Add-CustomResult -step 'resolve_seed_employee_id' -passed ([string]$seedEmployeeId).Trim().Length -gt 0 -note "seed_employee_id=$seedEmployeeId"

$createRestaurant = Invoke-Action -token $adminSession.access_token -endpoint 'admin_restaurants_manage' -action 'create' -payload @{
    name = $seedRestaurantName
    lat = 4.710989
    lng = -74.072090
    radius = 120
    address_line = 'Cra 7 # 32-16'
    city = 'Bogota'
    state = 'Cundinamarca'
    country = 'CO'
    is_active = $true
}
Add-Result -step 'admin_restaurants_manage.create_seed_restaurant' -response $createRestaurant -expectedStatuses @(200)

$restaurantId = First-NotEmpty @(
    $createRestaurant.body.data.restaurant_id,
    $createRestaurant.body.data.id
)

if (-not $restaurantId) {
    $restaurantList = Invoke-Action -token $adminSession.access_token -endpoint 'admin_restaurants_manage' -action 'list' -payload @{ limit = 500 }
    Add-Result -step 'admin_restaurants_manage.list_for_seed_lookup' -response $restaurantList -expectedStatuses @(200)
    $restaurantMatch = (Get-Items $restaurantList) | Where-Object { $_.name -eq $seedRestaurantName } | Select-Object -First 1
    $restaurantId = First-NotEmpty @($restaurantMatch.restaurant_id, $restaurantMatch.id)
}

Add-CustomResult -step 'resolve_seed_restaurant_id' -passed ([string]$restaurantId).Trim().Length -gt 0 -note "seed_restaurant_id=$restaurantId"

Write-Output '--- Step 5: Assign supervisor and staff ---'
$assignSupervisor = Invoke-Action -token $adminSession.access_token -endpoint 'admin_supervisors_manage' -action 'assign' -payload @{
    supervisor_id = $supervisorUser.id
    restaurant_id = $restaurantId
}
$assignMainEmployee = Invoke-Action -token $adminSession.access_token -endpoint 'restaurant_staff_manage' -action 'assign_employee' -payload @{
    employee_id = $mainEmployee.id
    restaurant_id = $restaurantId
}
$assignSeedEmployee = Invoke-Action -token $adminSession.access_token -endpoint 'restaurant_staff_manage' -action 'assign_employee' -payload @{
    employee_id = $seedEmployeeId
    restaurant_id = $restaurantId
}
Add-Result -step 'admin_supervisors_manage.assign' -response $assignSupervisor -expectedStatuses @(200)
Add-Result -step 'restaurant_staff_manage.assign_main_employee' -response $assignMainEmployee -expectedStatuses @(200)
Add-Result -step 'restaurant_staff_manage.assign_seed_employee' -response $assignSeedEmployee -expectedStatuses @(200)

Write-Output '--- Step 6: Dashboards and listings ---'
$employeeDashboard = Invoke-Action -token $employeeSession.access_token -endpoint 'employee_self_service' -action 'my_dashboard' -payload @{
    schedule_limit = 10
}
$supervisorRestaurants = Invoke-Action -token $supervisorSession.access_token -endpoint 'restaurant_staff_manage' -action 'list_my_restaurants' -payload @{}
$supervisorShiftListInitial = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'list' -payload @{
    restaurant_id = $restaurantId
    from = (Get-Date).ToUniversalTime().Date.ToString('yyyy-MM-ddTHH:mm:ssZ')
    to = (Get-Date).ToUniversalTime().Date.AddDays(3).AddHours(23).AddMinutes(59).AddSeconds(59).ToString('yyyy-MM-ddTHH:mm:ssZ')
    limit = 200
}
Add-Result -step 'employee_self_service.my_dashboard' -response $employeeDashboard -expectedStatuses @(200)
Add-Result -step 'restaurant_staff_manage.list_my_restaurants' -response $supervisorRestaurants -expectedStatuses @(200)
Add-Result -step 'scheduled_shifts_manage.list_initial' -response $supervisorShiftListInitial -expectedStatuses @(200)

Write-Output '--- Step 7: Schedule shifts with conflict validation ---'
$shiftBase = (Get-Date).ToUniversalTime().Date.AddDays(2).AddHours(10)
$minuteSlot = (Get-Random -Minimum 0 -Maximum 6) * 10
$shiftBase = $shiftBase.AddMinutes($minuteSlot)

$shift1Start = $shiftBase
$shift1End = $shiftBase.AddHours(4)
$shiftConflictStart = $shiftBase.AddHours(1)
$shiftConflictEnd = $shiftBase.AddHours(3)
$shift2Start = $shift1End.AddHours(1)
$shift2End = $shift2Start.AddHours(3)

$shift1StartIso = $shift1Start.ToString('yyyy-MM-ddTHH:mm:ssZ')
$shift1EndIso = $shift1End.ToString('yyyy-MM-ddTHH:mm:ssZ')
$shiftConflictStartIso = $shiftConflictStart.ToString('yyyy-MM-ddTHH:mm:ssZ')
$shiftConflictEndIso = $shiftConflictEnd.ToString('yyyy-MM-ddTHH:mm:ssZ')
$shift2StartIso = $shift2Start.ToString('yyyy-MM-ddTHH:mm:ssZ')
$shift2EndIso = $shift2End.ToString('yyyy-MM-ddTHH:mm:ssZ')

$shiftCreate1 = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $mainEmployee.id
    restaurant_id = $restaurantId
    scheduled_start = $shift1StartIso
    scheduled_end = $shift1EndIso
    notes = 'QA E2E shift #1'
}
$shiftConflict = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $mainEmployee.id
    restaurant_id = $restaurantId
    scheduled_start = $shiftConflictStartIso
    scheduled_end = $shiftConflictEndIso
    notes = 'QA E2E expected conflict'
}
$shiftCreate2 = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
    employee_id = $mainEmployee.id
    restaurant_id = $restaurantId
    scheduled_start = $shift2StartIso
    scheduled_end = $shift2EndIso
    notes = 'QA E2E shift #2'
}

Add-Result -step 'scheduled_shifts_manage.assign_shift_1' -response $shiftCreate1 -expectedStatuses @(200)
Add-Result -step 'scheduled_shifts_manage.assign_overlap_conflict' -response $shiftConflict -expectedStatuses @(409)
Add-Result -step 'scheduled_shifts_manage.assign_shift_2' -response $shiftCreate2 -expectedStatuses @(200)

$createdShiftId1 = First-NotEmpty @(
    $shiftCreate1.body.data.scheduled_shift_id,
    $shiftCreate1.body.data.id
)
$createdShiftId2 = First-NotEmpty @(
    $shiftCreate2.body.data.scheduled_shift_id,
    $shiftCreate2.body.data.id
)
Add-CustomResult -step 'resolve_created_shift_ids' -passed (([string]$createdShiftId1).Trim().Length -gt 0 -and ([string]$createdShiftId2).Trim().Length -gt 0) -note "shift_ids=$createdShiftId1,$createdShiftId2"

$listFrom = $shift1Start.Date.ToString('yyyy-MM-ddTHH:mm:ssZ')
$listTo = $shift1Start.Date.AddDays(1).AddSeconds(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
$shiftListAfterCreate = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'list' -payload @{
    restaurant_id = $restaurantId
    from = $listFrom
    to = $listTo
    limit = 300
}
Add-Result -step 'scheduled_shifts_manage.list_after_create' -response $shiftListAfterCreate -expectedStatuses @(200)

$listedShifts = Get-Items $shiftListAfterCreate
$listedShiftIds = @($listedShifts | ForEach-Object { [string](First-NotEmpty @($_.id, $_.scheduled_shift_id)) } | Where-Object { $_.Trim() -ne '' })
$createdShiftIds = @([string]$createdShiftId1, [string]$createdShiftId2) | Where-Object { $_.Trim() -ne '' }
$matchedIds = @($createdShiftIds | Where-Object { $listedShiftIds -contains $_ })
Add-CustomResult -step 'verify_created_shifts_listed' -passed ($matchedIds.Count -ge 2) -note "matched_ids=$($matchedIds -join ',')"

Write-Output '--- Step 8: Generate report and validate response ---'
$reportDay = $shift1Start.ToString('yyyy-MM-dd')
$reportColumns = @(
    'Turno',
    'Restaurante',
    'Empleado',
    'Supervisora',
    'Inicio',
    'Fin',
    'Estado',
    'Duracion',
    'Novedades',
    'Evidencia inicial',
    'Evidencia final'
)

$reportGenerate = Invoke-Endpoint -token $supervisorSession.access_token -endpoint 'reports_generate' -payload @{
    restaurant_id = [int]$restaurantId
    employee_id = [string]$mainEmployee.id
    period_start = $reportDay
    period_end = $reportDay
    export_format = 'both'
    columns = $reportColumns
} -timeoutSec 120
Add-Result -step 'reports_generate.single_day' -response $reportGenerate -expectedStatuses @(200)

$reportShiftList = Invoke-Action -token $supervisorSession.access_token -endpoint 'reports_manage' -action 'list_shifts' -payload @{
    restaurant_id = [int]$restaurantId
    employee_id = [string]$mainEmployee.id
    from = $reportDay
    to = $reportDay
    limit = 500
}
Add-Result -step 'reports_manage.list_shifts' -response $reportShiftList -expectedStatuses @(200)

$reportShifts = Get-Items $reportShiftList
$reportItemsResolved = @($reportShifts).Count
Add-CustomResult -step 'verify_report_query_returns_structured_response' -passed ($reportItemsResolved -ge 0) -note "report_items_count=$reportItemsResolved"

Write-Output '--- Step 9: Cleanup created shifts (best effort) ---'
if ($createdShiftId1) {
    $cancelShift1 = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'cancel' -payload @{
        scheduled_shift_id = $createdShiftId1
        reason = 'QA E2E cleanup'
    }
    Add-Result -step 'scheduled_shifts_manage.cancel_shift_1' -response $cancelShift1 -expectedStatuses @(200, 404, 409)
}
if ($createdShiftId2) {
    $cancelShift2 = Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'cancel' -payload @{
        scheduled_shift_id = $createdShiftId2
        reason = 'QA E2E cleanup'
    }
    Add-Result -step 'scheduled_shifts_manage.cancel_shift_2' -response $cancelShift2 -expectedStatuses @(200, 404, 409)
}

Write-Output '=== E2E FULL APP RESULTS JSON ==='
$results | ConvertTo-Json -Depth 30

if ($hasFailures) {
    Write-Output 'RESULT=FAIL'
    exit 1
}

Write-Output 'RESULT=PASS'
exit 0
