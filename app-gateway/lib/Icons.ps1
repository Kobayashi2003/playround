$script:IconLimit = 128KB
$script:SvgShapes = 'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'linearGradient', 'radialGradient', 'stop', 'clipPath'
$script:SvgAttributes = 'viewBox', 'preserveAspectRatio', 'id', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'fx', 'fy', 'd', 'points', 'transform',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'clip-path', 'clip-rule', 'clipPathUnits', 'gradientUnits', 'gradientTransform',
    'spreadMethod', 'offset', 'stop-color', 'stop-opacity'

function Read-AppIcon {
    param([string] $Root, [string] $File)

    if ($File -notmatch '^[^/\\:?#$]+(?:/[^/\\:?#$]+)*$' -or
        ($File -split '/') -match '^(\.{1,2}|.*[. ]$)' -or [IO.Path]::IsPathRooted($File)) {
        throw 'icon.file must be relative to the app, using / and ordinary path segments.'
    }
    $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
    if ($extension -notin '.png', '.svg') { throw 'icon.file must be a PNG or SVG.' }

    $path = $Root
    foreach ($segment in ($File -split '/')) {
        $path = Join-Path $path $segment
        $item = Get-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue
        if (-not $item -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            throw 'The icon file is missing or its path contains a link.'
        }
    }
    if ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $script:IconLimit) {
        throw 'The icon must be a file smaller than or equal to 128 KiB.'
    }

    $stream = [IO.File]::OpenRead($path)
    try {
        if ($stream.Length -gt $script:IconLimit) { throw 'The icon exceeds 128 KiB.' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $stream.ReadExactly($bytes)
    } finally {
        $stream.Dispose()
    }

    if ($extension -eq '.png') {
        if ($bytes.Length -lt 33 -or [Convert]::ToHexString($bytes, 0, 16) -cne '89504E470D0A1A0A0000000D49484452') {
            throw 'The icon is not a PNG file.'
        }
        $width = [Convert]::ToUInt32([Convert]::ToHexString($bytes, 16, 4), 16)
        $height = [Convert]::ToUInt32([Convert]::ToHexString($bytes, 20, 4), 16)
        if ($width -lt 1 -or $height -lt 1 -or $width -gt 512 -or $height -gt 512) {
            throw 'PNG icons must fit within 512 × 512 pixels.'
        }
        Add-Type -AssemblyName System.Drawing
        $buffer = [IO.MemoryStream]::new($bytes)
        try {
            $image = [Drawing.Image]::FromStream($buffer, $false, $true)
            $image.Dispose()
        } catch {
            throw 'The PNG icon could not be decoded.'
        } finally {
            $buffer.Dispose()
        }
        $type = 'image/png'
    } else {
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.MaxCharactersInDocument = $script:IconLimit
        $settings.IgnoreComments = $true
        $settings.IgnoreWhitespace = $true
        $buffer = [IO.MemoryStream]::new($bytes)
        $reader = [Xml.XmlReader]::Create($buffer, $settings)
        $namespace = 'http://www.w3.org/2000/svg'
        $seenRoot = $false
        try {
            while ($reader.Read()) {
                if ($reader.NodeType -eq [Xml.XmlNodeType]::ProcessingInstruction) {
                    throw 'SVG processing instructions are not allowed.'
                }
                if ($reader.NodeType -ne [Xml.XmlNodeType]::Element) { continue }
                if ($reader.Depth -eq 0) { $seenRoot = $reader.LocalName -ceq 'svg' }
                if (-not $seenRoot -or $reader.NamespaceURI -cne $namespace -or
                    $reader.LocalName -cnotin $script:SvgShapes -or $reader.Depth -gt 32) {
                    throw 'SVG icons support only static shapes, local gradients and clipping.'
                }
                while ($reader.MoveToNextAttribute()) {
                    if ($reader.Name -ceq 'xmlns' -and $reader.Value -ceq $namespace) { continue }
                    if ($reader.NamespaceURI -or $reader.Name -cnotin $script:SvgAttributes -or
                        ($reader.Value -match 'url\s*\(' -and $reader.Value -cnotmatch '^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$')) {
                        throw "SVG attribute '$($reader.Name)' is not allowed in an icon."
                    }
                }
                [void]$reader.MoveToElement()
            }
            if (-not $seenRoot) { throw 'The icon is not an SVG document.' }
        } finally {
            $reader.Dispose()
            $buffer.Dispose()
        }
        $type = 'image/svg+xml'
    }

    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    return @{ Bytes = $bytes; Type = $type; Extension = $extension; Hash = $hash }
}
