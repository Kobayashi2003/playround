using System.Globalization;

namespace NasDeck.Protocol;

public static class Format
{
    private static readonly string[] Units = ["B", "KB", "MB", "GB", "TB", "PB"];

    /// <summary>A size in binary units with three significant digits at most: 3.64 TB, 238 GB, 0 B.</summary>
    public static string Bytes(double bytes)
    {
        var value = Math.Max(bytes, 0);
        var unit = 0;
        while (value >= 1000 && unit < Units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        var digits = unit == 0 || value >= 100 ? "0" : value >= 10 ? "0.0" : "0.00";
        return value.ToString(digits, CultureInfo.InvariantCulture) + " " + Units[unit];
    }

    public static string Rate(double bytesPerSecond) => Bytes(bytesPerSecond) + "/s";

    /// <summary>The two largest units of a duration: 3d 4h, 2h 5m, 42m, 15s.</summary>
    public static string Duration(long seconds)
    {
        seconds = Math.Max(seconds, 0);
        var days = seconds / 86400;
        var hours = seconds % 86400 / 3600;
        var minutes = seconds % 3600 / 60;
        if (days > 0) return hours > 0 ? $"{days}d {hours}h" : $"{days}d";
        if (hours > 0) return minutes > 0 ? $"{hours}h {minutes}m" : $"{hours}h";
        return minutes > 0 ? $"{minutes}m" : $"{seconds}s";
    }

    /// <summary>A disk sleep timeout as a menu reads it: 20 min, 1 h, 1 h 30 min, never.</summary>
    public static string Timeout(int seconds)
    {
        if (seconds <= 0) return "never";
        var minutes = Math.Max(seconds / 60, 1);
        if (minutes < 60) return $"{minutes} min";
        return minutes % 60 == 0 ? $"{minutes / 60} h" : $"{minutes / 60} h {minutes % 60} min";
    }

    /// <summary>The part of a drive model a person recognises: "WDC WD40EZAX-00C8UB0" becomes "WD40EZAX".</summary>
    public static string ShortModel(string model)
    {
        var name = model.Trim();
        foreach (var prefix in (string[])["WDC ", "HGST ", "TOSHIBA ", "TOSHIBA-", "Hitachi "])
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) name = name[prefix.Length..];
        // A revision follows a dash and starts with a digit; "TR200" after one is the name itself.
        var dash = name.IndexOf('-');
        return dash > 3 && dash + 1 < name.Length && char.IsDigit(name[dash + 1]) ? name[..dash] : name;
    }
}
