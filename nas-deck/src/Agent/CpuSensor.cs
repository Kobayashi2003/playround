using LibreHardwareMonitor.Hardware;

namespace NasDeck.Agent;

/// <summary>
/// The CPU package temperature. It is read through the PawnIO driver, which Install-Agent.ps1 installs on
/// request; without the driver there is no reading and <see cref="Read"/> returns null.
/// </summary>
internal sealed class CpuSensor : IDisposable
{
    private readonly Computer? computer;

    internal CpuSensor(ILogger logger)
    {
        try
        {
            computer = new Computer { IsCpuEnabled = true };
            computer.Open();
        }
        catch (Exception error)
        {
            logger.LogWarning(error, "CPU sensors are unavailable.");
            computer = null;
        }
    }

    internal double? Read()
    {
        if (computer is null) return null;
        try
        {
            double? package = null, hottest = null;
            foreach (var hardware in computer.Hardware)
            {
                if (hardware.HardwareType != HardwareType.Cpu) continue;
                hardware.Update();
                foreach (var sensor in hardware.Sensors)
                {
                    if (sensor.SensorType != SensorType.Temperature || sensor.Value is not { } value || value <= 0) continue;
                    // "Distance to TjMax" sensors count down as the CPU heats up.
                    if (sensor.Name.Contains("Distance", StringComparison.OrdinalIgnoreCase)) continue;
                    if (sensor.Name.Contains("Package", StringComparison.OrdinalIgnoreCase)) package = value;
                    hottest = Math.Max(hottest ?? value, value);
                }
            }
            return (package ?? hottest) is { } reading ? Math.Round(reading, 1) : null;
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        try { computer?.Close(); }
        catch (Exception error) when (error is InvalidOperationException or IOException) { }
    }
}
