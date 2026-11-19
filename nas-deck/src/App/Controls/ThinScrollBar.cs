using System.Drawing.Drawing2D;

namespace NasDeck;

/// <summary>
/// A theme-aware, interactive thin scrollbar operating in logical (96 DPI) coordinates. Supports wheel scrolling,
/// thumb dragging and clicking the track, with zero native Win32 scrollbar chrome.
/// </summary>
internal sealed class ThinScrollBar
{
    private float dragGrabOffset;

    internal float Offset { get; set; }
    internal float ContentHeight { get; private set; }
    internal float ViewportHeight { get; private set; }
    internal RectangleF Track { get; private set; }
    internal bool Dragging { get; private set; }
    internal bool Hovered { get; private set; }

    internal float MaxOffset => Math.Max(0, ContentHeight - ViewportHeight);
    internal bool Visible => MaxOffset > 0.5f && Track.Height > 12;

    internal void Update(RectangleF track, float viewportHeight, float contentHeight)
    {
        Track = track;
        ViewportHeight = Math.Max(0, viewportHeight);
        ContentHeight = Math.Max(0, contentHeight);
        Offset = Math.Clamp(Offset, 0, MaxOffset);
    }

    internal RectangleF ThumbBounds()
    {
        if (!Visible) return RectangleF.Empty;
        var ratio = Math.Clamp(ViewportHeight / ContentHeight, 0, 1);
        var length = Math.Max(26, Track.Height * ratio);
        var travel = Math.Max(0, Track.Height - length);
        var top = Track.Top + travel * Math.Clamp(Offset / MaxOffset, 0, 1);
        var width = Hovered || Dragging ? 6f : 4.5f;
        return new RectangleF(Track.Right - width - 2, top, width, length);
    }

    internal bool HitTest(PointF point) => Visible && Track.Contains(point);

    internal bool ScrollWheel(int delta, float step)
    {
        if (!Visible) return false;
        var next = Math.Clamp(Offset - delta / 120f * step, 0, MaxOffset);
        if (Math.Abs(next - Offset) < 0.1f) return false;
        Offset = next;
        return true;
    }

    internal bool OnMouseDown(PointF point)
    {
        if (!Visible || !Track.Contains(point)) return false;
        var thumb = ThumbBounds();
        var hitThumb = RectangleF.Inflate(thumb, 4, 2);
        if (hitThumb.Contains(point))
        {
            Dragging = true;
            dragGrabOffset = point.Y - thumb.Top;
            return true;
        }
        var travel = Math.Max(1, Track.Height - thumb.Height);
        var targetTop = Math.Clamp(point.Y - thumb.Height / 2 - Track.Top, 0, travel);
        Offset = targetTop / travel * MaxOffset;
        Dragging = true;
        dragGrabOffset = thumb.Height / 2;
        return true;
    }

    internal bool OnMouseMove(PointF point)
    {
        if (Dragging && Visible)
        {
            var thumb = ThumbBounds();
            var travel = Math.Max(1, Track.Height - thumb.Height);
            var targetTop = Math.Clamp(point.Y - dragGrabOffset - Track.Top, 0, travel);
            var next = targetTop / travel * MaxOffset;
            var changed = Math.Abs(next - Offset) >= 0.1f;
            Offset = next;
            return changed;
        }
        var over = Visible && Track.Contains(point);
        if (over == Hovered) return false;
        Hovered = over;
        return true;
    }

    internal bool OnMouseUp()
    {
        if (!Dragging) return false;
        Dragging = false;
        return true;
    }

    internal bool OnMouseLeave()
    {
        if (!Hovered) return false;
        Hovered = false;
        return true;
    }

    /// <summary>Draws the scrollbar in logical coordinates (assuming <paramref name="g"/> is already scaled by DPI).</summary>
    internal void Paint(Graphics g)
    {
        if (!Visible) return;
        var thumb = ThumbBounds();
        if (Hovered || Dragging)
        {
            var rail = new RectangleF(thumb.X - 1, Track.Top, thumb.Width + 2, Track.Height);
            using var railPath = DeckTheme.RoundedRectangle(rail, (thumb.Width + 2) / 2);
            using var railBrush = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.45f));
            g.FillPath(railBrush, railPath);
        }
        var color = Dragging ? DeckTheme.Accent
            : Hovered ? DeckTheme.Muted
            : DeckTheme.Mix(DeckTheme.Border, DeckTheme.Muted, 0.35f);
        using var thumbPath = DeckTheme.RoundedRectangle(thumb, thumb.Width / 2);
        using var thumbBrush = new SolidBrush(color);
        g.FillPath(thumbBrush, thumbPath);
    }
}
