$subnet = "172.20.141."
1..254 | ForEach-Object {
    $ip = "$subnet$_"
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $tcp.BeginConnect($ip, 22, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(30)) {
            $tcp.EndConnect($async)
            Write-Output "PORT_22_FOUND: $ip"
        }
    } catch {}
    finally {
        $tcp.Close()
    }
}
