using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace NasDeck;

internal enum DeckGlyph { Refresh, Settings, Open, Exit, Power, More, ChevronUp, ChevronDown, Moon, Sun, Check, Folder, Screen, Timer, Pin, Info, Activity }

internal static class DeckIcons
{
    internal static Bitmap Create(DeckGlyph glyph, int size, Color? color = null)
    {
        var image = new Bitmap(size, size);
        using var graphics = Graphics.FromImage(image);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.ScaleTransform(size / 16f, size / 16f);
        using var pen = new Pen(color ?? DeckTheme.Text, 1.25f)
        {
            LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round
        };
        Draw(graphics, pen, glyph);
        return image;
    }

    /// <summary>Draws a glyph designed on a 16×16 grid; scale the graphics before calling.</summary>
    internal static void Draw(Graphics graphics, Pen pen, DeckGlyph glyph)
    {
        switch (glyph)
        {
            case DeckGlyph.Refresh:
                graphics.DrawArc(pen, 2.5f, 2.5f, 11, 11, 25, 292);
                graphics.DrawLines(pen, (PointF[])[new(13.3f, 2.4f), new(13.3f, 6.1f), new(9.6f, 6.1f)]);
                break;
            case DeckGlyph.Settings:
                graphics.DrawEllipse(pen, 3.6f, 3.6f, 8.8f, 8.8f);
                graphics.DrawEllipse(pen, 6.1f, 6.1f, 3.8f, 3.8f);
                Rays(graphics, pen, 4.4f, 6.4f);
                break;
            case DeckGlyph.Open:
                graphics.DrawLines(pen, (PointF[])[new(7.5f, 3), new(3, 3), new(3, 13), new(13, 13), new(13, 8.5f)]);
                graphics.DrawLines(pen, (PointF[])[new(9, 2), new(14, 2), new(14, 7)]);
                graphics.DrawLine(pen, 14, 2, 7.5f, 8.5f);
                break;
            case DeckGlyph.Exit:
                graphics.DrawLines(pen, (PointF[])[new(8, 2.5f), new(3, 2.5f), new(3, 13.5f), new(8, 13.5f)]);
                graphics.DrawLine(pen, 7, 8, 14, 8);
                graphics.DrawLines(pen, (PointF[])[new(11, 5), new(14, 8), new(11, 11)]);
                break;
            case DeckGlyph.Power:
                graphics.DrawArc(pen, 2.5f, 3, 11, 11, 300, 300);
                graphics.DrawLine(pen, 8, 1.5f, 8, 7.5f);
                break;
            case DeckGlyph.More:
                using (var brush = new SolidBrush(pen.Color))
                    foreach (var x in (float[])[3.2f, 8, 12.8f])
                        graphics.FillEllipse(brush, x - 1.2f, 6.8f, 2.4f, 2.4f);
                break;
            case DeckGlyph.ChevronUp:
                graphics.DrawLines(pen, (PointF[])[new(4, 10), new(8, 6), new(12, 10)]);
                break;
            case DeckGlyph.ChevronDown:
                graphics.DrawLines(pen, (PointF[])[new(4, 6), new(8, 10), new(12, 6)]);
                break;
            case DeckGlyph.Moon:
                // A crescent: the far side of a disc, closed by a shallower arc.
                using (var crescent = new GraphicsPath())
                {
                    crescent.AddArc(2.5f, 2.5f, 11, 11, 290, -260);
                    crescent.AddArc(5.6f, 0.6f, 10.4f, 10.4f, 44, 112);
                    crescent.CloseFigure();
                    graphics.DrawPath(pen, crescent);
                }
                break;
            case DeckGlyph.Sun:
                graphics.DrawEllipse(pen, 5.2f, 5.2f, 5.6f, 5.6f);
                Rays(graphics, pen, 4.6f, 6.4f);
                break;
            case DeckGlyph.Check:
                graphics.DrawLines(pen, (PointF[])[new(3.5f, 8.5f), new(6.5f, 11.5f), new(12.5f, 4.5f)]);
                break;
            case DeckGlyph.Folder:
                graphics.DrawLines(pen, (PointF[])[new(2, 4), new(6.2f, 4), new(7.6f, 5.6f), new(14, 5.6f), new(14, 12.5f), new(2, 12.5f), new(2, 4)]);
                break;
            case DeckGlyph.Screen:
                graphics.DrawRectangle(pen, 2, 3, 12, 8);
                graphics.DrawLine(pen, 8, 11, 8, 13.5f);
                graphics.DrawLine(pen, 5, 13.5f, 11, 13.5f);
                break;
            case DeckGlyph.Timer:
                graphics.DrawEllipse(pen, 2.5f, 3.5f, 11, 11);
                graphics.DrawLines(pen, (PointF[])[new(8, 6), new(8, 9), new(10.2f, 10.4f)]);
                graphics.DrawLine(pen, 6.5f, 1.5f, 9.5f, 1.5f);
                break;
            case DeckGlyph.Info:
                graphics.DrawEllipse(pen, 2.5f, 2.5f, 11, 11);
                graphics.DrawLine(pen, 8, 7.4f, 8, 11);
                graphics.DrawLine(pen, 8, 5, 8, 5.1f);
                break;
            case DeckGlyph.Pin:
                graphics.DrawLine(pen, 4.5f, 2, 11.5f, 2);
                graphics.DrawLines(pen, (PointF[])[new(6, 2), new(6, 6.5f), new(3.5f, 9.5f), new(12.5f, 9.5f), new(10, 6.5f), new(10, 2)]);
                graphics.DrawLine(pen, 8, 9.5f, 8, 14.5f);
                break;
            case DeckGlyph.Activity:
                graphics.DrawLines(pen, (PointF[])[new(1.8f, 8.5f), new(4.5f, 8.5f), new(6.4f, 3.5f), new(9.5f, 12.5f), new(11.6f, 8.5f), new(14.2f, 8.5f)]);
                break;
        }
    }

    private static void Rays(Graphics graphics, Pen pen, float inner, float outer)
    {
        for (var spoke = 0; spoke < 8; spoke++)
        {
            var angle = spoke * MathF.PI / 4;
            var x = MathF.Cos(angle);
            var y = MathF.Sin(angle);
            graphics.DrawLine(pen, 8 + x * inner, 8 + y * inner, 8 + x * outer, 8 + y * outer);
        }
    }

    /// <summary>The app icon with a status badge, sized for the notification area.</summary>
    internal static OwnedIcon CreateTrayIcon(Icon source, NasTone tone, int size)
    {
        using var bitmap = new Bitmap(size, size);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            using (var sized = new Icon(source, size, size))
                graphics.DrawIcon(sized, new Rectangle(0, 0, size, size));
            // Badge colors are fixed rather than themed: they sit on the taskbar, not on the app's surface.
            Color? badge = tone switch
            {
                NasTone.Ready => Color.FromArgb(34, 197, 94),
                NasTone.Partial or NasTone.Attention => Color.FromArgb(245, 158, 11),
                NasTone.Busy => Color.FromArgb(59, 130, 246),
                NasTone.Offline => Color.FromArgb(140, 140, 140),
                _ => null
            };
            if (badge is { } color)
            {
                var diameter = size * 0.56f;
                var outer = new RectangleF(size - diameter, size - diameter, diameter, diameter);
                using var ring = new SolidBrush(DeckTheme.TaskbarDark ? Color.FromArgb(28, 28, 28) : Color.FromArgb(240, 240, 240));
                graphics.FillEllipse(ring, outer);
                outer.Inflate(-size * 0.09f, -size * 0.09f);
                using var fill = new SolidBrush(color);
                graphics.FillEllipse(fill, outer);
            }
        }
        return new OwnedIcon(bitmap.GetHicon());
    }
}

internal sealed class OwnedIcon(IntPtr handle) : IDisposable
{
    internal Icon Icon { get; } = Icon.FromHandle(handle);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    public void Dispose()
    {
        Icon.Dispose();
        DestroyIcon(handle);
    }
}
