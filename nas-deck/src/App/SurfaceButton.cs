using System.Drawing.Drawing2D;

namespace NasDeck;

internal sealed class SurfaceButton : Button
{
    internal bool Primary { get; set; }
    internal bool Quiet { get; set; }
    private bool hovered;
    private bool pressed;

    internal SurfaceButton()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        FlatStyle = FlatStyle.Flat;
        Cursor = Cursors.Hand;
    }

    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? DeckTheme.Background);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var scale = DeviceDpi / 96f;
        using var shape = DeckTheme.RoundedRectangle(new RectangleF(1, 1, Width - 3, Height - 3), 7 * scale);
        var fill = Primary ? DeckTheme.Accent : Quiet ? DeckTheme.Background : DeckTheme.Panel;
        if (!Enabled) fill = Quiet ? DeckTheme.Background : DeckTheme.Panel;
        else if (Primary && pressed) fill = DeckTheme.Mix(DeckTheme.Accent, DeckTheme.Background, 0.25f);
        else if (Primary && hovered) fill = DeckTheme.Mix(DeckTheme.Accent, DeckTheme.Text, 0.12f);
        else if (pressed) fill = DeckTheme.Mix(DeckTheme.Border, DeckTheme.Text, 0.08f);
        else if (hovered) fill = DeckTheme.Border;
        using var brush = new SolidBrush(fill);
        g.FillPath(brush, shape);
        if (!Quiet && !Primary) { using var pen = new Pen(DeckTheme.Border); g.DrawPath(pen, shape); }
        if (Focused && ShowFocusCues)
        {
            using var focus = DeckTheme.RoundedRectangle(new RectangleF(4, 4, Width - 9, Height - 9), 5 * scale);
            using var pen = new Pen(Primary ? DeckTheme.Background : DeckTheme.Accent, 1.5f * scale);
            g.DrawPath(pen, focus);
        }
        var color = !Enabled ? DeckTheme.Mix(DeckTheme.Muted, fill, 0.35f) : Primary ? DeckTheme.Background : DeckTheme.Text;
        var bounds = ClientRectangle;
        if (Image is not null)
        {
            var gap = string.IsNullOrWhiteSpace(Text) ? 0 : (int)(7 * scale);
            var textWidth = string.IsNullOrWhiteSpace(Text) ? 0 : TextRenderer.MeasureText(Text.Trim(), Font).Width;
            var x = (Width - Image.Width - gap - textWidth) / 2;
            if (Enabled) g.DrawImage(Image, x, (Height - Image.Height) / 2);
            else ControlPaint.DrawImageDisabled(g, Image, x, (Height - Image.Height) / 2, fill);
            bounds = new Rectangle(x + Image.Width + gap, 0, textWidth, Height);
        }
        TextRenderer.DrawText(g, Text.Trim(), Font, bounds, color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}
