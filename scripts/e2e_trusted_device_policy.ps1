$ErrorActionPreference = 'Stop'

$base = 'https://orwingqtwoqfhcogggac.supabase.co'
$apiBase = 'https://orwingqtwoqfhcogggac.supabase.co/functions/v1'
$anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yd2luZ3F0d29xZmhjb2dnZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzEyMzcsImV4cCI6MjA4NjI0NzIzN30.QA86sHHsgN2K96YetNnafJdKWZffT1FugDTRB7E_drA'

function New-IdempotencyKey {
    return [guid]::NewGuid().ToString()
}

function New-DeviceFingerprint($label) {
    return "qa-$label-$([guid]::NewGuid().ToString('N'))"
}

function Login-Supabase($email, $password) {
    $payload = @{ email = $email; password = $password } | ConvertTo-Json
    return Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anonKey; 'Content-Type' = 'application/json' } -Body $payload
}

function Invoke-Edge($token, $endpoint, $payload = @{}, $deviceFingerprint = $null) {
    $json = $payload | ConvertTo-Json -Depth 20
    $headers = @{
        apikey = $anonKey
        Authorization = "Bearer $token"
        'Content-Type' = 'application/json'
        'Idempotency-Key' = (New-IdempotencyKey)
    }

    if ($deviceFingerprint) {
        $headers['x-device-fingerprint'] = $deviceFingerprint
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

function Invoke-Action($token, $endpoint, $action, $payload = @{}, $deviceFingerprint = $null) {
    $fullPayload = @{ action = $action }
    foreach ($k in $payload.Keys) {
        $fullPayload[$k] = $payload[$k]
    }
    return Invoke-Edge -token $token -endpoint $endpoint -payload $fullPayload -deviceFingerprint $deviceFingerprint
}

function Write-Step($name, $result, $expected) {
    $status = if ($result) { $result.status } else { -1 }
    $requestId = if ($result) { $result.request_id } else { '' }
    $okMark = if ($status -eq $expected -or ($expected -is [array] -and $expected -contains $status)) { 'OK' } else { 'FAIL' }
    $compactBody = ''
    if ($result -and $result.body) {
        $compactBody = [string]($result.body | ConvertTo-Json -Depth 10 -Compress)
    }

    Write-Output ("[$okMark] $name -> status=$status expected=$expected request_id=$requestId")
    if ($compactBody) {
        Write-Output ("      body=$compactBody")
    }

    return ($okMark -eq 'OK')
}

function New-StepReport($name, $result, $expected) {
    $status = if ($result) { $result.status } else { -1 }
    $requestId = if ($result) { $result.request_id } else { '' }
    $expectedArray = @($expected)
    $passed = $expectedArray -contains $status
    return [pscustomobject]@{
        step = $name
        status = $status
        expected = ($expectedArray -join '|')
        passed = $passed
        request_id = $requestId
        body = $result.body
    }
}

$stamp = (Get-Date).ToString('yyyyMMddHHmmss')
$seedEmployeeEmail = "qa.device.$stamp@gmail.com"
$seedEmployeePassword = '123456'
$fingerprintA = New-DeviceFingerprint -label 'device-a'
$fingerprintB = New-DeviceFingerprint -label 'device-b'

Write-Output '=== TRUSTED DEVICE STRICT POLICY E2E ==='
Write-Output "seed_email=$seedEmployeeEmail"
Write-Output "fingerprint_a=$fingerprintA"
Write-Output "fingerprint_b=$fingerprintB"

Write-Output '--- login admin ---'
$adminSession = Login-Supabase -email 'admin@gmail.com' -password '123456'

Write-Output '--- create qa employee account ---'
$createEmployee = Invoke-Action -token $adminSession.access_token -endpoint 'admin_users_manage' -action 'create' -payload @{
    email = $seedEmployeeEmail
    role = 'empleado'
    password = $seedEmployeePassword
    full_name = 'Empleado QA Device Policy'
    phone_number = '+573009990011'
    is_active = $true
}

if (-not $createEmployee.ok) {
    throw "No se pudo crear usuario QA. status=$($createEmployee.status) request_id=$($createEmployee.request_id)"
}

$seedEmployeeId = $createEmployee.body.data.id
if (-not $seedEmployeeId) { $seedEmployeeId = $createEmployee.body.data.user_id }
if (-not $seedEmployeeId) { $seedEmployeeId = $createEmployee.body.data.created_user.id }

Write-Output "seed_employee_id=$seedEmployeeId"
Write-Output "seed_employee_create_request_id=$($createEmployee.request_id)"

Write-Output '--- login qa employee ---'
$employeeSession = Login-Supabase -email $seedEmployeeEmail -password $seedEmployeePassword

$allPassed = $true
$reports = @()

Write-Output '--- step 0: cleanup best effort (revoke A/B) ---'
$cleanupA = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_revoke' -payload @{ device_fingerprint = $fingerprintA } -deviceFingerprint $fingerprintA
$cleanupB = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_revoke' -payload @{ device_fingerprint = $fingerprintB } -deviceFingerprint $fingerprintB
Write-Output "cleanup_a status=$($cleanupA.status) request_id=$($cleanupA.request_id)"
Write-Output "cleanup_b status=$($cleanupB.status) request_id=$($cleanupB.request_id)"

Write-Output '--- step 1: register first device A (expected 200) ---'
$step1 = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_register' -payload @{
    device_fingerprint = $fingerprintA
    device_name = 'QA Device A'
    platform = 'web'
} -deviceFingerprint $fingerprintA
$reports += New-StepReport -name 'step1_register_A' -result $step1 -expected 200
$allPassed = (Write-Step -name 'step1_register_A' -result $step1 -expected 200) -and $allPassed

Write-Output '--- step 2: register second device B without revoke (expected 409) ---'
$step2 = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_register' -payload @{
    device_fingerprint = $fingerprintB
    device_name = 'QA Device B'
    platform = 'web'
} -deviceFingerprint $fingerprintB
$reports += New-StepReport -name 'step2_register_B_without_revoke' -result $step2 -expected 409
$allPassed = (Write-Step -name 'step2_register_B_without_revoke' -result $step2 -expected 409) -and $allPassed

Write-Output '--- step 3: revoke active device A (expected 200) ---'
$step3 = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_revoke' -payload @{ device_fingerprint = $fingerprintA } -deviceFingerprint $fingerprintA
$reports += New-StepReport -name 'step3_revoke_A' -result $step3 -expected 200
$allPassed = (Write-Step -name 'step3_revoke_A' -result $step3 -expected 200) -and $allPassed

Write-Output '--- step 4: register new device B after revoke (expected 200) ---'
$step4 = Invoke-Edge -token $employeeSession.access_token -endpoint 'trusted_device_register' -payload @{
    device_fingerprint = $fingerprintB
    device_name = 'QA Device B'
    platform = 'web'
} -deviceFingerprint $fingerprintB
$reports += New-StepReport -name 'step4_register_B_after_revoke' -result $step4 -expected 200
$allPassed = (Write-Step -name 'step4_register_B_after_revoke' -result $step4 -expected 200) -and $allPassed

Write-Output '--- step 5: sensitive action from B phone_otp_send (expected 200) ---'
$step5 = Invoke-Edge -token $employeeSession.access_token -endpoint 'phone_otp_send' -payload @{ device_fingerprint = $fingerprintB } -deviceFingerprint $fingerprintB
$reports += New-StepReport -name 'step5_phone_otp_send_B' -result $step5 -expected 200
$allPassed = (Write-Step -name 'step5_phone_otp_send_B' -result $step5 -expected 200) -and $allPassed

Write-Output '--- step 6: same sensitive action from old device A (expected non-200) ---'
$step6 = Invoke-Edge -token $employeeSession.access_token -endpoint 'phone_otp_send' -payload @{ device_fingerprint = $fingerprintA } -deviceFingerprint $fingerprintA
$reports += New-StepReport -name 'step6_phone_otp_send_A_should_fail' -result $step6 -expected @(401,403,409,422)
$allPassed = (Write-Step -name 'step6_phone_otp_send_A_should_fail' -result $step6 -expected @(401,403,409,422)) -and $allPassed

Write-Output '=== REQUEST_IDS_JSON ==='
$reports | ConvertTo-Json -Depth 20

Write-Output '=== SUMMARY ==='
if ($allPassed) {
    Write-Output 'RESULT=PASS'
    exit 0
}

Write-Output 'RESULT=FAIL'
exit 1
