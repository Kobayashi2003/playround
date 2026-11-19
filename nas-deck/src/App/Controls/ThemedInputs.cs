using System.Drawing.Drawing2D;

namespace NasDeck;

/// <summary>
/// A rounded, theme-aware checklist with crisp vector checkboxes and an interactive <see cref="ThinScrollBar"/>.
/// Replaces WinForms' <c>CheckedListBox</c>, whose native Win32 scrollbar glitches under dark themes.
/// </summary>
internal sealed class ThemedCheckList : Control
{
    private const float RowHeight = 28f;
    private const float PadX = 10f;
    private const float PadY = 5f;
    private const float ScrollTrackWidth = 14f;
    private const TextFormatFlags TextFlags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
        | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;

    private sealed class Entry(string label, bool isChecked)
    {
        internal string Label { get; } = label;
        internal bool Checked { get; set; } = isChecked;
    }

    private readonly List<Entry> items = [];
    private readonly ThinScrollBar scroll = new();
    private int hoverIndex = -1;
    private int focusIndex = -1;

    internal string EmptyText { get; set; } = "No items.";
    internal event EventHandler? CheckedChanged;

    internal ThemedCheckList()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        TabStop = true;
        BackColor = DeckTheme.Background;
        Font = DeckTheme.Caption;
        DeckTheme.Changed += OnThemeChanged;
    }

    private float DpiScale => DeviceDpi / 96f;
    internal int TotalCount => items.Count;
    internal int CheckedCount => items.Count(item => item.Checked);
    internal string[] CheckedItems => items.Where(item => item.Checked).Select(item => item.Label).ToArray();

    internal void SetItems(IEnumerable<(string Label, bool Checked)> entries)
    {
        items.Clear();
        foreach (var (label, isChecked) in entries) items.Add(new Entry(label, isChecked));
        hoverIndex = -1;
        focusIndex = items.Count > 0 ? 0 : -1;
        UpdateScroll();
        Invalidate();
        CheckedChanged?.Invoke(this, EventArgs.Empty);
    }

    internal void SetAllChecked(bool value)
    {
        var changed = false;
        foreach (var item in items)
        {
            if (item.Checked == value) continue;
            item.Checked = value;
            changed = true;
        }
        if (!changed) return;
        Invalidate();
        CheckedChanged?.Invoke(this, EventArgs.Empty);
    }

    private void OnThemeChanged()
    {
        BackColor = DeckTheme.Background;
        Invalidate();
    }

    private void UpdateScroll()
    {
        var width = Width / DpiScale;
        var height = Height / DpiScale;
        var viewport = Math.Max(0, height - PadY * 2);
        var content = items.Count * RowHeight;
        scroll.Update(new RectangleF(width - ScrollTrackWidth - 2, PadY, ScrollTrackWidth, viewport), viewport, content);
    }

    private int RowAt(PointF logical)
    {
        if (logical.X < 2 || logical.X >= Width / DpiScale - (scroll.Visible ? ScrollTrackWidth + 4 : 2)) return -1;
        var y = logical.Y - PadY + scroll.Offset;
        if (y < 0) return -1;
        var index = (int)(y / RowHeight);
        return index >= 0 && index < items.Count ? index : -1;
    }

    private void Toggle(int index)
    {
        if (!Enabled || index < 0 || index >= items.Count) return;
        items[index].Checked = !items[index].Checked;
        focusIndex = index;
        Invalidate();
        CheckedChanged?.Invoke(this, EventArgs.Empty);
    }

    private void EnsureVisible(int index)
    {
        if (index < 0 || index >= items.Count) return;
        var top = index * RowHeight;
        var bottom = top + RowHeight;
        if (top < scroll.Offset) scroll.Offset = top;
        else if (bottom > scroll.Offset + scroll.ViewportHeight) scroll.Offset = bottom - scroll.ViewportHeight;
        UpdateScroll();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateScroll();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        hoverIndex = -1;
        Cursor = Cursors.Default;
        Invalidate();
    }

    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        var dirty = scroll.OnMouseMove(point);
        if (scroll.Dragging)
        {
            if (dirty) Invalidate();
            return;
        }
        var nextHover = Enabled && !scroll.HitTest(point) ? RowAt(point) : -1;
        if (nextHover != hoverIndex)
        {
            hoverIndex = nextHover;
            dirty = true;
        }
        Cursor = scroll.HitTest(point) || nextHover >= 0 ? Cursors.Hand : Cursors.Default;
        if (dirty) Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        var dirty = scroll.OnMouseLeave();
        if (hoverIndex != -1) { hoverIndex = -1; dirty = true; }
        Cursor = Cursors.Default;
        if (dirty) Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        if (Enabled) Focus();
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        if (scroll.OnMouseDown(point))
        {
            Capture = true;
            Invalidate();
            return;
        }
        if (Enabled && RowAt(point) is >= 0 and var index) Toggle(index);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (scroll.OnMouseUp())
        {
            Capture = false;
            Invalidate();
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (scroll.ScrollWheel(e.Delta, RowHeight * 2.5f)) Invalidate();
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData is Keys.Up or Keys.Down or Keys.Home or Keys.End or Keys.PageUp or Keys.PageDown or Keys.Space || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (!Enabled || items.Count == 0) return;
        switch (e.KeyCode)
        {
            case Keys.Down:
                focusIndex = Math.Min(items.Count - 1, Math.Max(0, focusIndex + 1));
                EnsureVisible(focusIndex);
                Invalidate();
                e.Handled = true;
                break;
            case Keys.Up:
                focusIndex = Math.Max(0, focusIndex <= 0 ? 0 : focusIndex - 1);
                EnsureVisible(focusIndex);
                Invalidate();
                e.Handled = true;
                break;
            case Keys.Home:
                focusIndex = 0;
                EnsureVisible(focusIndex);
                Invalidate();
                e.Handled = true;
                break;
            case Keys.End:
                focusIndex = items.Count - 1;
                EnsureVisible(focusIndex);
                Invalidate();
                e.Handled = true;
                break;
            case Keys.Space:
                Toggle(focusIndex < 0 ? 0 : focusIndex);
                e.Handled = true;
                break;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        UpdateScroll();
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? DeckTheme.Background);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var scale = DpiScale;
        var width = Width / scale;
        var height = Height / scale;
        var saved = g.Save();
        g.ScaleTransform(scale, scale);

        var surface = new RectangleF(0.5f, 0.5f, width - 1, height - 1);
        using (var path = DeckTheme.RoundedRectangle(surface, 7))
        {
            using var fill = new SolidBrush(Enabled ? DeckTheme.Panel : DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.65f));
            g.FillPath(fill, path);
            using var border = new Pen(Focused && Enabled ? DeckTheme.Accent : DeckTheme.Border, 1);
            g.DrawPath(border, path);
        }

        if (items.Count == 0)
        {
            g.Restore(saved);
            TextRenderer.DrawText(g, EmptyText, DeckTheme.Caption, ClientRectangle, DeckTheme.Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
            return;
        }

        var clipLogical = new RectangleF(2, PadY, width - 4, Math.Max(0, height - PadY * 2));
        var listState = g.Save();
        g.SetClip(clipLogical);
        var contentRight = width - (scroll.Visible ? ScrollTrackWidth + 6 : 6);
        for (var i = 0; i < items.Count; i++)
        {
            var rowY = PadY + i * RowHeight - scroll.Offset;
            if (rowY + RowHeight < PadY || rowY > height - PadY) continue;

            var rowRect = new RectangleF(6, rowY + 1, contentRight - 6, RowHeight - 2);
            if (Enabled && i == hoverIndex)
            {
                using var hoverPath = DeckTheme.RoundedRectangle(rowRect, 5);
                using var hoverBrush = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.7f));
                g.FillPath(hoverBrush, hoverPath);
            }
            if (Enabled && Focused && ShowFocusCues && i == focusIndex)
            {
                using var focusPath = DeckTheme.RoundedRectangle(rowRect, 5);
                using var focusPen = new Pen(DeckTheme.Mix(DeckTheme.Accent, DeckTheme.Panel, 0.45f), 1);
                g.DrawPath(focusPen, focusPath);
            }

            var item = items[i];
            var box = new RectangleF(PadX + 2, rowY + (RowHeight - 15) / 2, 15, 15);
            DrawCheckBoxGlyph(g, box, item.Checked, Enabled);

            var textColor = Enabled ? DeckTheme.Text : DeckTheme.Mix(DeckTheme.Muted, DeckTheme.Panel, 0.35f);
            var textRect = Rectangle.Round(new RectangleF((box.Right + 9) * scale, rowY * scale,
                Math.Max(0, contentRight - box.Right - 13) * scale, RowHeight * scale));
            TextRenderer.DrawText(g, item.Label, Font, textRect, textColor, TextFlags | TextFormatFlags.PreserveGraphicsClipping);
        }
        g.Restore(listState);
        scroll.Paint(g);
        g.Restore(saved);
    }

    internal static void DrawCheckBoxGlyph(Graphics g, RectangleF box, bool isChecked, bool enabled)
    {
        using var path = DeckTheme.RoundedRectangle(box, 3.5f);
        if (isChecked)
        {
            var fillColor = enabled ? DeckTheme.Accent : DeckTheme.Mix(DeckTheme.Muted, DeckTheme.Panel, 0.45f);
            using var fill = new SolidBrush(fillColor);
            g.FillPath(fill, path);
            using var pen = new Pen(DeckTheme.Background, 1.7f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
            g.DrawLines(pen, [
                new PointF(box.X + box.Width * 0.24f, box.Y + box.Height * 0.52f),
                new PointF(box.X + box.Width * 0.43f, box.Y + box.Height * 0.71f),
                new PointF(box.X + box.Width * 0.77f, box.Y + box.Height * 0.31f)
            ]);
        }
        else
        {
            using var fill = new SolidBrush(enabled ? DeckTheme.Background : DeckTheme.Panel);
            g.FillPath(fill, path);
            using var border = new Pen(enabled ? DeckTheme.Muted : DeckTheme.Border, 1.2f);
            g.DrawPath(border, path);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DeckTheme.Changed -= OnThemeChanged;
        base.Dispose(disposing);
    }
}

/// <summary>A clean theme-aware checkbox matching <see cref="ThemedCheckList"/> and <see cref="SurfaceButton"/>.</summary>
internal sealed class ThemedCheckBox : Control
{
    private bool isChecked;
    private bool hovered;

    internal bool Checked
    {
        get => isChecked;
        set
        {
            if (isChecked == value) return;
            isChecked = value;
            Invalidate();
            CheckedChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    internal event EventHandler? CheckedChanged;

    internal ThemedCheckBox()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        TabStop = true;
        Cursor = Cursors.Hand;
        Font = DeckTheme.Strong;
        Height = 24;
        DeckTheme.Changed += OnThemeChanged;
    }

    private float DpiScale => DeviceDpi / 96f;

    private void OnThemeChanged() => Invalidate();
    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
    protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left || !Enabled) return;
        Focus();
        Checked = !Checked;
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Space && Enabled) { Checked = !Checked; e.Handled = true; }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(BackColor == Color.Empty ? Parent?.BackColor ?? DeckTheme.Background : BackColor);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var scale = DpiScale;
        var height = Height / scale;
        var saved = g.Save();
        g.ScaleTransform(scale, scale);

        var box = new RectangleF(1, (height - 15) / 2, 15, 15);
        if (hovered && Enabled && !isChecked)
        {
            using var glow = DeckTheme.RoundedRectangle(box, 3.5f);
            using var fill = new SolidBrush(DeckTheme.Border);
            g.FillPath(fill, glow);
        }
        ThemedCheckList.DrawCheckBoxGlyph(g, box, isChecked, Enabled);
        if (Focused && ShowFocusCues)
        {
            using var focus = DeckTheme.RoundedRectangle(RectangleF.Inflate(box, 2, 2), 4.5f);
            using var pen = new Pen(DeckTheme.Accent, 1.2f);
            g.DrawPath(pen, focus);
        }
        g.Restore(saved);

        var textX = (int)Math.Round(25 * scale);
        var textBounds = new Rectangle(textX, 0, Math.Max(0, Width - textX), Height);
        TextRenderer.DrawText(g, Text, Font, textBounds, Enabled ? DeckTheme.Text : DeckTheme.Muted,
            TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DeckTheme.Changed -= OnThemeChanged;
        base.Dispose(disposing);
    }
}

/// <summary>A unified segmented tab switcher matching NAS Deck's pill aesthetic without competing with primary CTAs.</summary>
internal sealed class SegmentedTabs : Control
{
    private readonly string[] labels;
    private int selectedIndex;
    private int hoverIndex = -1;

    internal int SelectedIndex
    {
        get => selectedIndex;
        set
        {
            var clamped = Math.Clamp(value, 0, Math.Max(0, labels.Length - 1));
            if (clamped == selectedIndex) return;
            selectedIndex = clamped;
            Invalidate();
            SelectedIndexChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    internal event EventHandler? SelectedIndexChanged;

    internal SegmentedTabs(string[] labels)
    {
        this.labels = labels;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        TabStop = true;
        Cursor = Cursors.Hand;
        Font = DeckTheme.Caption;
        DeckTheme.Changed += OnThemeChanged;
    }

    private float DpiScale => DeviceDpi / 96f;
    private void OnThemeChanged() => Invalidate();

    private int IndexAt(int x)
    {
        if (labels.Length == 0 || Width <= 0) return -1;
        return Math.Clamp((int)(x / (Width / (float)labels.Length)), 0, labels.Length - 1);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var next = IndexAt(e.X);
        if (next != hoverIndex) { hoverIndex = next; Invalidate(); }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverIndex != -1) { hoverIndex = -1; Invalidate(); }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        Focus();
        if (IndexAt(e.X) is >= 0 and var index) SelectedIndex = index;
    }

    protected override bool IsInputKey(Keys keyData) => keyData is Keys.Left or Keys.Right || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Left && labels.Length > 0) { SelectedIndex = (SelectedIndex + labels.Length - 1) % labels.Length; e.Handled = true; }
        else if (e.KeyCode == Keys.Right && labels.Length > 0) { SelectedIndex = (SelectedIndex + 1) % labels.Length; e.Handled = true; }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent?.BackColor ?? DeckTheme.Background);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var scale = DpiScale;
        var width = Width / scale;
        var height = Height / scale;
        var saved = g.Save();
        g.ScaleTransform(scale, scale);

        var track = new RectangleF(0.5f, 0.5f, width - 1, height - 1);
        using (var trackPath = DeckTheme.RoundedRectangle(track, 8))
        {
            using var fill = new SolidBrush(DeckTheme.Panel);
            g.FillPath(fill, trackPath);
            using var border = new Pen(DeckTheme.Border, 1);
            g.DrawPath(border, trackPath);
        }

        if (labels.Length > 0)
        {
            const float pad = 3f;
            var segW = (width - pad * 2) / labels.Length;
            for (var i = 0; i < labels.Length; i++)
            {
                var pill = new RectangleF(pad + i * segW, pad, segW, height - pad * 2);
                var active = i == selectedIndex;
                var hot = i == hoverIndex;
                if (active)
                {
                    using var pillPath = DeckTheme.RoundedRectangle(pill, 6);
                    using var fill = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Accent, 0.22f));
                    g.FillPath(fill, pillPath);
                    using var border = new Pen(DeckTheme.Mix(DeckTheme.Border, DeckTheme.Accent, 0.7f), 1);
                    g.DrawPath(border, pillPath);
                }
                else if (hot)
                {
                    using var pillPath = DeckTheme.RoundedRectangle(pill, 6);
                    using var fill = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.6f));
                    g.FillPath(fill, pillPath);
                }
                var textBounds = Rectangle.Round(new RectangleF(pill.X * scale, pill.Y * scale, pill.Width * scale, pill.Height * scale));
                TextRenderer.DrawText(g, labels[i], active ? DeckTheme.Strong : DeckTheme.Caption, textBounds,
                    active ? DeckTheme.Text : hot ? DeckTheme.Text : DeckTheme.Muted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            }
        }
        g.Restore(saved);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DeckTheme.Changed -= OnThemeChanged;
        base.Dispose(disposing);
    }
}
