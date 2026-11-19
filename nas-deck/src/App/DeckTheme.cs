using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace NasDeck;

internal enum NasTone { Unknown, Ready, Partial, Offline, Busy, Attention }

internal static class DeckTheme
{
    private const string Personalize = @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    internal static bool Dark { get; private set; } = ReadDark();
    private static bool ReadDark() => Microsoft.Win32.Registry.GetValue(Personalize, "AppsUseLightTheme", 0) is not int value || value == 0;
    internal static bool TaskbarDark => Microsoft.Win32.Registry.GetValue(Personalize, "SystemUsesLightTheme", 0) is not int value || value == 0;
    internal static Color Background => Dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(249, 249, 249);
    internal static Color Panel => Dark ? Color.FromArgb(44, 44, 44) : Color.FromArgb(238, 238, 238);
    internal static Color Border => Dark ? Color.FromArgb(64, 64, 64) : Color.FromArgb(214, 214, 214);
    internal static Color Text => Dark ? Color.FromArgb(242, 242, 242) : Color.FromArgb(28, 28, 28);
    internal static Color Muted => Dark ? Color.FromArgb(170, 170, 170) : Color.FromArgb(104, 104, 104);
    internal static Color Ready => Dark ? Color.FromArgb(108, 203, 146) : Color.FromArgb(16, 124, 65);
    internal static Color Warning => Dark ? Color.FromArgb(240, 190, 100) : Color.FromArgb(157, 93, 0);
    internal static Color Danger => Dark ? Color.FromArgb(255, 132, 124) : Color.FromArgb(196, 43, 28);
    internal static Color Accent => Dark ? Color.FromArgb(118, 185, 237) : Color.FromArgb(0, 95, 184);

    internal static readonly Font Menu = new("Segoe UI", 9);
    internal static readonly Font MenuStrong = new("Segoe UI Semibold", 9);
    internal static readonly Font Heading = new("Segoe UI Semibold", 10.5f);
    internal static readonly Font Strong = new("Segoe UI Semibold", 9);
    internal static readonly Font Caption = new("Segoe UI", 9);
    internal static readonly Font Small = new("Segoe UI", 8.25f);
    internal static readonly Font Label = new("Segoe UI Semibold", 7.5f);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    internal static event Action? Changed;

    internal static Panel CreateDivider()
    {
        var divider = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        divider.Paint += (_, e) =>
        {
            using var pen = new Pen(Border, 1);
            e.Graphics.DrawLine(pen, 0, divider.Height / 2, divider.Width, divider.Height / 2);
        };
        return divider;
    }

    /// <summary>Follows the system's light or dark setting; a framed window also gets a matching title bar.</summary>
    internal static void Attach(Form form)
    {
        void Frame()
        {
            var dark = Dark ? 1 : 0;
            DwmSetWindowAttribute(form.Handle, 20, ref dark, 4);
            if (form.FormBorderStyle == FormBorderStyle.None)
            {
                var round = 2;
                DwmSetWindowAttribute(form.Handle, 33, ref round, 4);
                var border = ColorTranslator.ToWin32(Border);
                DwmSetWindowAttribute(form.Handle, 34, ref border, 4);
                return;
            }
            var caption = ColorTranslator.ToWin32(Background);
            var text = ColorTranslator.ToWin32(Text);
            DwmSetWindowAttribute(form.Handle, 35, ref caption, 4);
            DwmSetWindowAttribute(form.Handle, 36, ref text, 4);
        }
        form.HandleCreated += (_, _) => Frame();
        form.Activated += (_, _) =>
        {
            Refresh();
            Frame();
        };
    }

    /// <summary>Re-reads the system setting and recolours every open window when it changed.</summary>
    internal static void Refresh()
    {
        var next = ReadDark();
        if (next == Dark) return;
        var old = Palette();
        Dark = next;
        var updated = Palette();
        foreach (Form window in Application.OpenForms) Recolor(window);
        Changed?.Invoke();

        void Recolor(Control control)
        {
            var back = Array.IndexOf(old, control.BackColor);
            var fore = Array.IndexOf(old, control.ForeColor);
            if (back >= 0) control.BackColor = updated[back];
            if (fore >= 0) control.ForeColor = updated[fore];
            foreach (Control child in control.Controls) Recolor(child);
            control.Invalidate();
        }
    }

    private static Color[] Palette() => [Background, Panel, Border, Text, Muted, Ready, Warning, Accent];

    internal static int Scale(int pixels, int dpi) => (pixels * dpi + 48) / 96;

    internal static Color Mix(Color from, Color to, float amount) => Color.FromArgb(
        (int)(from.R + (to.R - from.R) * amount),
        (int)(from.G + (to.G - from.G) * amount),
        (int)(from.B + (to.B - from.B) * amount));

    internal static Color ToneColor(NasTone tone) => tone switch
    {
        NasTone.Ready => Ready,
        NasTone.Partial or NasTone.Attention => Warning,
        NasTone.Busy => Accent,
        _ => Muted
    };

    internal static void StyleButton(Button button, bool primary = false)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.UseVisualStyleBackColor = false;
        button.BackColor = primary ? Accent : Panel;
        button.ForeColor = primary ? Background : Text;
        button.FlatAppearance.BorderSize = primary ? 0 : 1;
        button.FlatAppearance.BorderColor = Border;
        if (button is SurfaceButton surface) surface.Primary = primary;
    }

    internal static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
    {
        var diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
