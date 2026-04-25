$ErrorActionPreference = 'Stop'

$base = 'https://orwingqtwoqfhcogggac.supabase.co'
$apiBase = 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

$records = [System.Collections.Generic.List[object]]::new()
$summary = [ordered]@{}

function New-IdempotencyKey {
    return [guid]::NewGuid().ToString()
}

function Parse-JsonSafe($raw) {
    if (-not $raw) {
        return $null
    }

    try {
        return $raw | ConvertFrom-Json -Depth 40
    } catch {
        return @{ raw = $raw }
    }
}

function First-NotEmpty($values) {
    foreach ($value in $values) {
        if ($null -eq $value) {
            continue
        }

        $text = [string]$value
        if ($text.Trim().Length -gt 0) {
            return $value
        }
    }

    return $null
}

function Add-Record($group, $step, $durationMs, $status, $ok, $requestId = '', $note = '', $extra = $null) {
    $records.Add([pscustomobject]@{
        group = [string]$group
        step = [string]$step
        duration_ms = [math]::Round([double]$durationMs, 2)
        status = if ($null -eq $status) { $null } else { [int]$status }
        ok = [bool]$ok
        request_id = [string]$requestId
        note = [string]$note
        extra = $extra
    })
}

function Measure-HttpStep($group, $step, $expectedStatuses, [scriptblock]$action, $note = '') {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $action
        $sw.Stop()

        $status = [int]($result.status)
        $ok = @($expectedStatuses | ForEach-Object { [int]$_ }) -contains $status
        Add-Record -group $group -step $step -durationMs $sw.Elapsed.TotalMilliseconds -status $status -ok $ok -requestId ($result.request_id || '') -note $note -extra $result.body

        return $result
    } catch {
        $sw.Stop()
        Add-Record -group $group -step $step -durationMs $sw.Elapsed.TotalMilliseconds -status $null -ok $false -note ($_.Exception.Message)
        throw
    }
}

function Measure-TaskStep($group, $step, [scriptblock]$action, $note = '') {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $action
        $sw.Stop()
        Add-Record -group $group -step $step -durationMs $sw.Elapsed.TotalMilliseconds -status 200 -ok $true -note $note
        return $result
    } catch {
        $sw.Stop()
        Add-Record -group $group -step $step -durationMs $sw.Elapsed.TotalMilliseconds -status $null -ok $false -note ($_.Exception.Message)
        throw
    }
}

function Login-Supabase($email, $password) {
    $payload = @{ email = $email; password = $password } | ConvertTo-Json
    return Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{
        apikey = $anonKey
        'Content-Type' = 'application/json'
    } -Body $payload
}

function Invoke-Endpoint($token, $endpoint, $payload = @{}, $deviceFingerprint = $null, $shiftOtpToken = $null, $timeoutSec = 60, $method = 'POST') {
    $headers = @{
        apikey = $anonKey
        Authorization = "Bearer $token"
        'Content-Type' = 'application/json'
        'Idempotency-Key' = (New-IdempotencyKey)
    }

    if ($deviceFingerprint) {
        $headers['x-device-fingerprint'] = $deviceFingerprint
    }

    if ($shiftOtpToken) {
        $headers['x-shift-otp-token'] = $shiftOtpToken
    }

    $bodyJson = if ($method -eq 'GET') { $null } else { $payload | ConvertTo-Json -Depth 40 }
    $response = Invoke-WebRequest -Method $method -Uri "$apiBase/$endpoint" -Headers $headers -Body $bodyJson -SkipHttpErrorCheck -TimeoutSec $timeoutSec
    $body = Parse-JsonSafe $response.Content

    return [pscustomobject]@{
        status = [int]$response.StatusCode
        request_id = ($response.Headers['X-Request-Id'] | Select-Object -First 1)
        body = $body
        ok = ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
    }
}

function Invoke-Action($token, $endpoint, $action, $payload = @{}, $deviceFingerprint = $null, $shiftOtpToken = $null, $timeoutSec = 60) {
    $finalPayload = @{ action = $action }
    foreach ($key in $payload.Keys) {
        $finalPayload[$key] = $payload[$key]
    }

    return Invoke-Endpoint -token $token -endpoint $endpoint -payload $finalPayload -deviceFingerprint $deviceFingerprint -shiftOtpToken $shiftOtpToken -timeoutSec $timeoutSec
}

function Ensure-LegalConsent($token, $deviceFingerprint = $null) {
    $statusResp = Invoke-Action -token $token -endpoint 'legal_consent' -action 'status' -payload @{} -deviceFingerprint $deviceFingerprint
    if (-not $statusResp.ok) {
        return $statusResp
    }

    if ($statusResp.body.data.accepted -eq $true) {
        return $statusResp
    }

    $termId = First-NotEmpty @(
        $statusResp.body.data.active_terms.id,
        $statusResp.body.data.active_terms.legal_terms_id,
        $statusResp.body.data.active_term.id,
        $statusResp.body.data.active_term.legal_terms_id
    )

    if (-not $termId) {
        return $statusResp
    }

    $acceptPayload = @{
        legal_terms_id = $termId
    }

    $termsCode = First-NotEmpty @(
        $statusResp.body.data.active_terms.terms_code,
        $statusResp.body.data.active_terms.code,
        $statusResp.body.data.active_term.terms_code,
        $statusResp.body.data.active_term.code
    )
    if ($termsCode) {
        $acceptPayload.terms_code = $termsCode
    }

    $version = First-NotEmpty @(
        $statusResp.body.data.active_terms.version,
        $statusResp.body.data.active_term.version
    )
    if ($version) {
        $acceptPayload.version = $version
    }

    $acceptResp = Invoke-Action -token $token -endpoint 'legal_consent' -action 'accept' -payload $acceptPayload -deviceFingerprint $deviceFingerprint
    if (-not $acceptResp.ok) {
        return $acceptResp
    }

    return Invoke-Action -token $token -endpoint 'legal_consent' -action 'status' -payload @{} -deviceFingerprint $deviceFingerprint
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

function Get-RestaurantCoord($restaurant, $keys) {
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture
    $numberStyles = [System.Globalization.NumberStyles]::Float -bor [System.Globalization.NumberStyles]::AllowThousands

    foreach ($key in $keys) {
        $cursor = $restaurant
        foreach ($segment in ($key -split '\.')) {
            if ($null -eq $cursor) {
                break
            }
            $cursor = $cursor.$segment
        }

        if ($null -eq $cursor) {
            continue
        }

        $raw = [string]$cursor
        $number = 0.0
        if ([double]::TryParse($raw, $numberStyles, $invariant, [ref]$number)) {
            return $number
        }

        $normalized = $raw.Replace(',', '.')
        if ([double]::TryParse($normalized, $numberStyles, $invariant, [ref]$number)) {
            return $number
        }
    }

    return $null
}

function Measure-Batch($group, $baseStep, $iterations, [scriptblock]$action, $expectedStatuses) {
    for ($i = 1; $i -le $iterations; $i++) {
        [void](Measure-HttpStep -group $group -step "$baseStep#$i" -expectedStatuses $expectedStatuses -action $action)
    }
}

function Upload-Signed($signedUrl, [byte[]]$bytes, $contentType = 'image/jpeg') {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest -Method Put -Uri $signedUrl -Headers @{ 'Content-Type' = $contentType } -Body $bytes -SkipHttpErrorCheck -TimeoutSec 120
    $sw.Stop()
    return [pscustomobject]@{
        status = [int]$response.StatusCode
        request_id = ''
        body = $null
        ok = ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
        duration_ms = $sw.Elapsed.TotalMilliseconds
    }
}

Write-Output '=== PERF DIAGNOSTICS START ==='
$stamp = (Get-Date).ToString('yyyyMMddHHmmss')

$adminSession = Measure-TaskStep -group 'auth' -step 'login_admin' -action { Login-Supabase -email 'admin@gmail.com' -password '123456' }
$supervisorSession = Measure-TaskStep -group 'auth' -step 'login_supervisor' -action { Login-Supabase -email 'supervisora@gmail.com' -password '123456' }
$employeeSession = Measure-TaskStep -group 'auth' -step 'login_employee' -action { Login-Supabase -email 'miguel@gmail.com' -password '123456' }

$consentEmployee = Measure-HttpStep -group 'auth' -step 'employee_legal_consent' -expectedStatuses @(200) -action {
    Ensure-LegalConsent -token $employeeSession.access_token
}

$supervisorRestaurants = Measure-HttpStep -group 'read_paths' -step 'list_my_restaurants' -expectedStatuses @(200) -action {
    Invoke-Action -token $supervisorSession.access_token -endpoint 'restaurant_staff_manage' -action 'list_my_restaurants' -payload @{}
}

$restaurants = Get-Items $supervisorRestaurants
if ($restaurants.Count -eq 0) {
    throw 'La supervisora no tiene restaurantes asignados para ejecutar las pruebas de rendimiento.'
}

$probeRestaurant = $restaurants | Select-Object -First 1
$probeRestaurantId = First-NotEmpty @($probeRestaurant.restaurant_id, $probeRestaurant.id)
if (-not $probeRestaurantId) {
    throw 'No se pudo resolver restaurant_id para las pruebas.'
}

$probeLat = Get-RestaurantCoord -restaurant $probeRestaurant -keys @('lat', 'latitude', 'location.lat', 'geo.lat')
$probeLng = Get-RestaurantCoord -restaurant $probeRestaurant -keys @('lng', 'longitude', 'location.lng', 'geo.lng')
if ($null -eq $probeLat -or $null -eq $probeLng) {
    $probeLat = 4.710989
    $probeLng = -74.072090
}

$today = (Get-Date).ToUniversalTime().Date
$fromIso = $today.ToString('yyyy-MM-ddTHH:mm:ssZ')
$toIso = $today.AddDays(1).AddSeconds(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
$fromDay = $today.ToString('yyyy-MM-dd')
$toDay = $today.AddDays(1).ToString('yyyy-MM-dd')

Measure-Batch -group 'read_paths' -baseStep 'employee_dashboard' -iterations 5 -expectedStatuses @(200) -action {
    Invoke-Action -token $employeeSession.access_token -endpoint 'employee_self_service' -action 'my_dashboard' -payload @{
        schedule_limit = 10
        pending_tasks_limit = 10
    }
}

Measure-Batch -group 'read_paths' -baseStep 'employee_active_shift' -iterations 5 -expectedStatuses @(200) -action {
    Invoke-Action -token $employeeSession.access_token -endpoint 'employee_self_service' -action 'my_active_shift' -payload @{}
}

Measure-Batch -group 'read_paths' -baseStep 'supervisor_shift_list' -iterations 5 -expectedStatuses @(200) -action {
    Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'list' -payload @{
        restaurant_id = $probeRestaurantId
        from = $fromIso
        to = $toIso
        limit = 200
    }
}

Measure-Batch -group 'read_paths' -baseStep 'reports_list_shifts' -iterations 5 -expectedStatuses @(200) -action {
    Invoke-Action -token $supervisorSession.access_token -endpoint 'reports_manage' -action 'list_shifts' -payload @{
        restaurant_id = $probeRestaurantId
        from = $fromDay
        to = $toDay
        limit = 500
    }
}

Measure-Batch -group 'read_paths' -baseStep 'reports_generate' -iterations 3 -expectedStatuses @(200) -action {
    Invoke-Endpoint -token $supervisorSession.access_token -endpoint 'reports_generate' -payload @{
        restaurant_id = $probeRestaurantId
        period_start = $fromDay
        period_end = $toDay
        export_format = 'both'
        columns = @('Turno','Restaurante','Empleado','Inicio','Fin','Estado')
    } -timeoutSec 120
}

$refreshTokenResult = Measure-TaskStep -group 'auth' -step 'refresh_employee_session' -action {
    $payload = @{ refresh_token = $employeeSession.refresh_token } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=refresh_token" -Headers @{
        apikey = $anonKey
        'Content-Type' = 'application/json'
    } -Body $payload
}

$seedEmail = "qa.perf.$stamp@gmail.com"
$seedPhone = "+57300$((Get-Random -Minimum 1000000 -Maximum 9999999))"
$seedFingerprint = "qa-perf-device-$([guid]::NewGuid().ToString('N'))"
$seedPassword = '123456'

$createEmployee = Measure-HttpStep -group 'start_end_flow' -step 'admin_create_perf_employee' -expectedStatuses @(200) -action {
    Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'create' -payload @{
        email = $seedEmail
        role = 'empleado'
        password = $seedPassword
        full_name = 'Empleado QA Performance'
        phone_number = $seedPhone
        is_active = $true
    }
}

$seedEmployeeId = First-NotEmpty @(
    $createEmployee.body.data.id,
    $createEmployee.body.data.user_id,
    $createEmployee.body.data.created_user.id
)

if (-not $seedEmployeeId) {
    $employeeList = Measure-HttpStep -group 'start_end_flow' -step 'admin_list_employees_for_seed_lookup' -expectedStatuses @(200) -action {
        Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'list' -payload @{
            role = 'empleado'
            limit = 500
        }
    }
    $seedEmployee = (Get-Items $employeeList) | Where-Object { $_.email -eq $seedEmail } | Select-Object -First 1
    $seedEmployeeId = First-NotEmpty @($seedEmployee.id, $seedEmployee.user_id)
}

if (-not $seedEmployeeId) {
    throw 'No se pudo resolver el ID del empleado QA de performance.'
}

$assignEmployee = Measure-HttpStep -group 'start_end_flow' -step 'assign_perf_employee_to_restaurant' -expectedStatuses @(200) -action {
    Invoke-Action -token $adminSession.access_token -endpoint 'restaurant_staff_manage' -action 'assign_employee' -payload @{
        employee_id = $seedEmployeeId
        restaurant_id = $probeRestaurantId
    }
}

$seedEmployeeSession = Measure-TaskStep -group 'start_end_flow' -step 'login_perf_employee' -action {
    Login-Supabase -email $seedEmail -password $seedPassword
}

$seedConsent = Measure-HttpStep -group 'start_end_flow' -step 'perf_employee_legal_consent' -expectedStatuses @(200) -action {
    Ensure-LegalConsent -token $seedEmployeeSession.access_token -deviceFingerprint $seedFingerprint
}

$registerTrusted = Measure-HttpStep -group 'start_end_flow' -step 'trusted_device_register_perf_employee' -expectedStatuses @(200,409) -action {
    Invoke-Endpoint -token $seedEmployeeSession.access_token -endpoint 'trusted_device_register' -payload @{
        device_fingerprint = $seedFingerprint
        device_name = 'QA Perf Device'
        platform = 'web'
    } -deviceFingerprint $seedFingerprint
}

$shiftStart = (Get-Date).ToUniversalTime().AddMinutes(2)
$shiftEnd = $shiftStart.AddHours(4)

$assignShift = Measure-HttpStep -group 'start_end_flow' -step 'schedule_shift_for_perf_employee' -expectedStatuses @(200) -action {
    Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'assign' -payload @{
        employee_id = $seedEmployeeId
        restaurant_id = $probeRestaurantId
        scheduled_start = $shiftStart.ToString('yyyy-MM-ddTHH:mm:ssZ')
        scheduled_end = $shiftEnd.ToString('yyyy-MM-ddTHH:mm:ssZ')
        notes = 'QA PERF synthetic shift'
    }
}

$scheduledShiftId = First-NotEmpty @(
    $assignShift.body.data.scheduled_shift_id,
    $assignShift.body.data.id
)

if (-not $scheduledShiftId) {
    throw 'No se pudo resolver scheduled_shift_id para la prueba de inicio/cierre.'
}

$otpSend = Measure-HttpStep -group 'start_end_flow' -step 'otp_send_before_start' -expectedStatuses @(200) -action {
    Invoke-Endpoint -token $seedEmployeeSession.access_token -endpoint 'phone_otp_send' -payload @{ device_fingerprint = $seedFingerprint } -deviceFingerprint $seedFingerprint
}

$debugCode = First-NotEmpty @(
    $otpSend.body.data.debug_code,
    $otpSend.body.debug_code
)
if (-not $debugCode) {
    throw 'No se recibió debug_code para validar OTP en entorno de prueba.'
}

$otpVerify = Measure-HttpStep -group 'start_end_flow' -step 'otp_verify_before_start' -expectedStatuses @(200) -action {
    Invoke-Endpoint -token $seedEmployeeSession.access_token -endpoint 'phone_otp_verify' -payload @{
        code = [string]$debugCode
        device_fingerprint = $seedFingerprint
    } -deviceFingerprint $seedFingerprint
}

$shiftOtpToken = First-NotEmpty @(
    $otpVerify.body.data.verification_token,
    $otpVerify.body.verification_token
)
if (-not $shiftOtpToken) {
    throw 'No se pudo resolver verification_token OTP para operaciones sensibles.'
}

$shiftStartCall = Measure-HttpStep -group 'start_end_flow' -step 'shifts_start' -expectedStatuses @(200) -action {
    Invoke-Endpoint -token $seedEmployeeSession.access_token -endpoint 'shifts_start' -payload @{
        restaurant_id = $probeRestaurantId
        scheduled_shift_id = $scheduledShiftId
        lat = $probeLat
        lng = $probeLng
        fit_for_work = $true
        declaration = 'Me encuentro en condiciones de iniciar labores.'
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$activeShift = Measure-HttpStep -group 'start_end_flow' -step 'my_active_shift_after_start' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'employee_self_service' -action 'my_active_shift' -payload @{} -deviceFingerprint $seedFingerprint
}

$activeShiftId = First-NotEmpty @(
    $activeShift.body.data.active_shift.id,
    $activeShift.body.data.active_shift.shift_id,
    $activeShift.body.data.active_shift.shiftId,
    $activeShift.body.data.shift.id,
    $activeShift.body.data.shift.shift_id,
    $activeShift.body.data.shift.shiftId,
    $activeShift.body.data.shift_id,
    $activeShift.body.data.shiftId,
    $activeShift.body.data.id,
    $activeShift.body.active_shift.id,
    $activeShift.body.active_shift.shift_id,
    $activeShift.body.active_shift.shiftId,
    $activeShift.body.shift.id,
    $activeShift.body.shift.shift_id,
    $activeShift.body.shift.shiftId,
    $activeShift.body.shift_id,
    $activeShift.body.shiftId,
    $activeShift.body.id
)
if (-not $activeShiftId) {
    $activeShiftId = First-NotEmpty @(
        $shiftStartCall.body.data.shift_id,
        $shiftStartCall.body.data.shiftId,
        $shiftStartCall.body.data.shift.id,
        $shiftStartCall.body.data.id,
        $shiftStartCall.body.shift_id
    )
}
if (-not $activeShiftId) {
    $debugPath = Join-Path (Get-Location) 'test-results/perf_diagnostics.active_shift_debug.json'
    @{
        shift_start_response = $shiftStartCall.body
        active_shift_response = $activeShift.body
    } | ConvertTo-Json -Depth 40 | Set-Content -Path $debugPath -Encoding UTF8
    throw "No se pudo resolver shift_id luego de iniciar el turno. Revisa $debugPath"
}

$summaryBeforeUpload = Measure-HttpStep -group 'start_end_flow' -step 'summary_by_shift_before_upload' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'shift_evidence_manage' -action 'summary_by_shift' -payload @{ shift_id = $activeShiftId } -deviceFingerprint $seedFingerprint
}

$pixelJpeg = [System.Convert]::FromBase64String('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFhUVFRUVFRUVFRUVFRUVFhUWFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAUAAEAAAAAAAAAAAAAAAAAAAAJ/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAByA//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAEFAg//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/AQ//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/AQ//2Q==')

$startUploadRequest = Measure-HttpStep -group 'start_end_flow' -step 'request_upload_inicio' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'evidence_upload' -action 'request_upload' -payload @{
        shift_id = $activeShiftId
        type = 'inicio'
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$startSignedUrl = First-NotEmpty @(
    $startUploadRequest.body.data.upload.signedUrl,
    $startUploadRequest.body.data.signedUrl,
    $startUploadRequest.body.upload.signedUrl,
    $startUploadRequest.body.signedUrl
)
$startPath = First-NotEmpty @(
    $startUploadRequest.body.data.upload.path,
    $startUploadRequest.body.data.path,
    $startUploadRequest.body.upload.path,
    $startUploadRequest.body.path
)
if (-not $startSignedUrl -or -not $startPath) {
    throw 'No se pudo resolver signedUrl/path para evidencia de inicio.'
}

$startUploadPut = Measure-TaskStep -group 'start_end_flow' -step 'upload_signed_inicio_put' -action {
    $putResponse = Upload-Signed -signedUrl $startSignedUrl -bytes $pixelJpeg
    if (-not $putResponse.ok) {
        throw "Upload inicio fallo con status=$($putResponse.status)"
    }
    return $putResponse
}

$startFinalize = Measure-HttpStep -group 'start_end_flow' -step 'finalize_upload_inicio' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'evidence_upload' -action 'finalize_upload' -payload @{
        shift_id = $activeShiftId
        type = 'inicio'
        path = $startPath
        lat = $probeLat
        lng = $probeLng
        accuracy = 10
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
        meta = @{ area = 'General'; area_label = 'General'; photo_label = 'Inicio' }
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$endUploadRequest = Measure-HttpStep -group 'start_end_flow' -step 'request_upload_fin' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'evidence_upload' -action 'request_upload' -payload @{
        shift_id = $activeShiftId
        type = 'fin'
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$endSignedUrl = First-NotEmpty @(
    $endUploadRequest.body.data.upload.signedUrl,
    $endUploadRequest.body.data.signedUrl,
    $endUploadRequest.body.upload.signedUrl,
    $endUploadRequest.body.signedUrl
)
$endPath = First-NotEmpty @(
    $endUploadRequest.body.data.upload.path,
    $endUploadRequest.body.data.path,
    $endUploadRequest.body.upload.path,
    $endUploadRequest.body.path
)
if (-not $endSignedUrl -or -not $endPath) {
    throw 'No se pudo resolver signedUrl/path para evidencia final.'
}

$endUploadPut = Measure-TaskStep -group 'start_end_flow' -step 'upload_signed_fin_put' -action {
    $putResponse = Upload-Signed -signedUrl $endSignedUrl -bytes $pixelJpeg
    if (-not $putResponse.ok) {
        throw "Upload fin fallo con status=$($putResponse.status)"
    }
    return $putResponse
}

$endFinalize = Measure-HttpStep -group 'start_end_flow' -step 'finalize_upload_fin' -expectedStatuses @(200) -action {
    Invoke-Action -token $seedEmployeeSession.access_token -endpoint 'evidence_upload' -action 'finalize_upload' -payload @{
        shift_id = $activeShiftId
        type = 'fin'
        path = $endPath
        lat = $probeLat
        lng = $probeLng
        accuracy = 10
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
        meta = @{ area = 'General'; area_label = 'General'; photo_label = 'Fin' }
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$endShiftCall = Measure-HttpStep -group 'start_end_flow' -step 'shifts_end' -expectedStatuses @(200,409,422) -action {
    Invoke-Endpoint -token $seedEmployeeSession.access_token -endpoint 'shifts_end' -payload @{
        shift_id = $activeShiftId
        lat = $probeLat
        lng = $probeLng
        fit_for_work = $true
        declaration = 'Cierre de turno QA performance.'
        early_end_reason = 'Cierre anticipado de prueba tecnica'
    } -deviceFingerprint $seedFingerprint -shiftOtpToken $shiftOtpToken
}

$cancelShift = Measure-HttpStep -group 'start_end_flow' -step 'cancel_scheduled_shift_cleanup' -expectedStatuses @(200,404,409) -action {
    Invoke-Action -token $supervisorSession.access_token -endpoint 'scheduled_shifts_manage' -action 'cancel' -payload @{
        scheduled_shift_id = $scheduledShiftId
        reason = 'cleanup perf diagnostics'
    }
}

$overallOk = ($records | Where-Object { -not $_.ok }).Count -eq 0

function Get-Percentile($sortedValues, $p) {
    if (-not $sortedValues -or $sortedValues.Count -eq 0) {
        return 0
    }

    $index = [math]::Ceiling(($p / 100) * $sortedValues.Count) - 1
    if ($index -lt 0) { $index = 0 }
    if ($index -ge $sortedValues.Count) { $index = $sortedValues.Count - 1 }
    return [double]$sortedValues[$index]
}

$groupSummaries = @()
$recordsByGroup = $records | Group-Object group
foreach ($group in $recordsByGroup) {
    $durations = @($group.Group | ForEach-Object { [double]$_.duration_ms } | Sort-Object)
    $avg = if ($durations.Count -gt 0) { ($durations | Measure-Object -Average).Average } else { 0 }
    $max = if ($durations.Count -gt 0) { ($durations | Measure-Object -Maximum).Maximum } else { 0 }
    $groupSummaries += [pscustomobject]@{
        group = $group.Name
        count = $durations.Count
        avg_ms = [math]::Round($avg, 2)
        p50_ms = [math]::Round((Get-Percentile -sortedValues $durations -p 50), 2)
        p90_ms = [math]::Round((Get-Percentile -sortedValues $durations -p 90), 2)
        max_ms = [math]::Round($max, 2)
        failed_steps = ($group.Group | Where-Object { -not $_.ok }).Count
    }
}

$output = [pscustomobject]@{
    generated_at = (Get-Date).ToString('o')
    overall_ok = $overallOk
    records = $records
    summaries = $groupSummaries
    metadata = [pscustomobject]@{
        seed_email = $seedEmail
        seed_employee_id = $seedEmployeeId
        probe_restaurant_id = $probeRestaurantId
        probe_lat = $probeLat
        probe_lng = $probeLng
        scheduled_shift_id = $scheduledShiftId
        active_shift_id = $activeShiftId
    }
}

$jsonOutputPath = Join-Path (Get-Location) 'test-results/perf_diagnostics.latest.json'
$output | ConvertTo-Json -Depth 40 | Set-Content -Path $jsonOutputPath -Encoding UTF8

Write-Output '=== PERF DIAGNOSTICS SUMMARY ==='
$groupSummaries | Format-Table -AutoSize
Write-Output "output_file=$jsonOutputPath"

if ($overallOk) {
    Write-Output 'RESULT=PASS'
    exit 0
}

Write-Output 'RESULT=WARN'
exit 0
