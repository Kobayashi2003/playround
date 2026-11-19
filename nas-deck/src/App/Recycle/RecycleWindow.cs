using System.Drawing.Drawing2D;

namespace NasDeck;

internal enum RecycleChoice { Cancel, MoveToBin, DeletePermanently }

internal sealed class RecycleWindow : Form
{
    private readonly RecycleTable table;
    private readonly Label status = new()
    {
        AutoEllipsis = true, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft,
        Font = DeckTheme.Small, Margin = Padding.Empty
    };
    private readonly FlowLayoutPanel leftActions = new()
    {
        FlowDirection = FlowDirection.LeftToRight, Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty
    };
    private readonly FlowLayoutPanel rightActions = new()
    {
        FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty
    };
    private readonly bool browser;
    private SurfaceButton? restore, purge, selectAll;
    private bool statusAlert;
    internal event Action<Guid[], bool>? Requested;

    internal RecycleWindow(string? headingText, bool browser = false, int previewRows = 0)
    {
        this.browser = browser;
        table = new RecycleTable(showDate: browser, selectable: browser)
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 6, 0, 0),
            EmptyText = "The recycle bin is empty."
        };
        Text = "NAS Recycle Bin";
        Font = DeckTheme.Caption;
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        var initialHeight = browser ? 430 : Math.Clamp(previewRows * 28 + 180, 212, 376);
        ClientSize = new Size(browser ? 720 : 540, initialHeight);
        MinimumSize = new Size(browser ? 560 : 460, browser ? 300 : 204);
        FormBorderStyle = browser ? FormBorderStyle.Sizable : FormBorderStyle.FixedDialog;
        MaximizeBox = browser;
        MinimizeBox = browser;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = DeckTheme.Background;
        ForeColor = DeckTheme.Text;
        DeckTheme.Attach(this);

        var hasHeading = !browser && !string.IsNullOrWhiteSpace(headingText);
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, RowCount = hasHeading ? 5 : 4, ColumnCount = 1, Padding = new Padding(20, 14, 20, 16)
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        var row = 0;
        if (hasHeading)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
            layout.Controls.Add(new Label
            {
                Text = headingText, Dock = DockStyle.Fill, Font = DeckTheme.Heading,
                TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(-2, 0, 0, 0)
            }, 0, row++);
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            layout.Controls.Add(status, 0, row++);
        }
        else
        {
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            var bar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 84));
            bar.Controls.Add(status, 0, 0);
            selectAll = new SurfaceButton { Text = "Select all", Dock = DockStyle.Fill, Font = DeckTheme.Small, Margin = new Padding(0, 1, 0, 1) };
            DeckTheme.StyleButton(selectAll);
            selectAll.Click += (_, _) => table.ToggleSelectAll();
            bar.Controls.Add(selectAll, 1, 0);
            layout.Controls.Add(bar, 0, row++);
        }

        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(table, 0, row++);

        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 16));
        layout.Controls.Add(DeckTheme.CreateDivider(), 0, row++);

        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));
        footer.Controls.Add(leftActions, 0, 0);
        footer.Controls.Add(rightActions, 1, 0);
        layout.Controls.Add(footer, 0, row);

        Controls.Add(layout);

        if (browser)
        {
            restore = AddButton(rightActions, "Restore", primary: true, danger: false, () => Requested?.Invoke(table.SelectedIds(), false));
            purge = AddButton(leftActions, "Delete permanently…", primary: false, danger: true, () => Requested?.Invoke(table.SelectedIds(), true));
            table.SelectionChanged += (_, _) => UpdateActions();
            table.RowActivated += (_, _) => { if (restore.Enabled) restore.PerformClick(); };
        }
        ApplyTheme();
        DeckTheme.Changed += ApplyTheme;
    }

    private void ApplyTheme()
    {
        BackColor = DeckTheme.Background;
        ForeColor = DeckTheme.Text;
        status.ForeColor = statusAlert ? DeckTheme.Danger : DeckTheme.Muted;
        table.Invalidate();
    }

    private static SurfaceButton AddButton(FlowLayoutPanel panel, string label, bool primary, bool danger, Action action)
    {
        var font = primary ? DeckTheme.Strong : DeckTheme.Caption;
        var width = Math.Max(82, TextRenderer.MeasureText(label, font).Width + 26);
        var margin = panel.Controls.Count == 0
            ? Padding.Empty
            : panel.FlowDirection == FlowDirection.RightToLeft ? new Padding(0, 0, 8, 0) : new Padding(8, 0, 0, 0);
        var button = new SurfaceButton
        {
            Text = label, Size = new Size(width, 34), Font = font, Danger = danger, Margin = margin
        };
        DeckTheme.StyleButton(button, primary);
        button.Click += (_, _) => action();
        panel.Controls.Add(button);
        return button;
    }

    internal void Reload(RecycledItem[] items, string? message = null)
    {
        table.SetRows(items.Select(item => new RecycleRow(
            item.Id, item.Name, Path.GetDirectoryName(item.Original) ?? "",
            item.Removed.LocalDateTime.ToString("yyyy-MM-dd HH:mm"), item.Original)).ToArray());
        statusAlert = false;
        status.ForeColor = DeckTheme.Muted;
        status.Text = message ?? (items.Length == 0
            ? "The recycle bin is empty."
            : $"{items.Length} item{(items.Length == 1 ? "" : "s")}  ·  Select items to restore or delete permanently.");
        UpdateActions();
    }

    private void UpdateActions()
    {
        var selected = table.SelectedCount;
        var total = table.RowCount;
        if (restore is not null && purge is not null) restore.Enabled = purge.Enabled = selected > 0;
        if (selectAll is not null)
        {
            selectAll.Enabled = total > 0;
            selectAll.Text = total > 0 && selected == total ? "Clear all" : "Select all";
        }
    }

    internal static RecycleChoice PromptRecycle(IEnumerable<string> paths, IWin32Window? owner = null)
    {
        var list = paths.ToArray();
        var noun = list.Length == 1 ? "1 item" : $"{list.Length} items";
        using var dialog = new RecycleWindow($"Move {noun} to NAS Recycle Bin?", browser: false, previewRows: list.Length);
        dialog.table.SetRows(list.Select(path => new RecycleRow(
            Guid.Empty, Path.GetFileName(path), Path.GetDirectoryName(path) ?? "", "", path)).ToArray());
        dialog.status.Text = "Items stay on the NAS and can be restored from NAS Deck.";

        var choice = RecycleChoice.Cancel;
        var armedPermanent = false;
        SurfaceButton? permanentButton = null;
        permanentButton = AddButton(dialog.leftActions, "Delete permanently", primary: false, danger: true, () =>
        {
            if (!armedPermanent)
            {
                armedPermanent = true;
                permanentButton!.Text = "Confirm delete";
                permanentButton.Primary = true;
                permanentButton.Font = DeckTheme.Strong;
                permanentButton.Width = Math.Max(124, TextRenderer.MeasureText(permanentButton.Text, DeckTheme.Strong).Width + 26);
                permanentButton.Invalidate();
                dialog.statusAlert = true;
                dialog.status.ForeColor = DeckTheme.Danger;
                dialog.status.Text = "Click again to permanently delete — this cannot be undone.";
                return;
            }
            choice = RecycleChoice.DeletePermanently;
            dialog.DialogResult = DialogResult.OK;
        });

        AddButton(dialog.rightActions, "Move to bin", primary: true, danger: false, () =>
        {
            choice = RecycleChoice.MoveToBin;
            dialog.DialogResult = DialogResult.OK;
        });
        var cancel = AddButton(dialog.rightActions, "Cancel", primary: false, danger: false, () =>
        {
            choice = RecycleChoice.Cancel;
            dialog.DialogResult = DialogResult.Cancel;
        });
        dialog.CancelButton = cancel;
        dialog.Shown += (_, _) => { dialog.Activate(); cancel.Focus(); };
        return dialog.ShowDialog(owner) == DialogResult.OK ? choice : RecycleChoice.Cancel;
    }

    internal static bool Confirm(string title, string note, string action, IEnumerable<string> paths, IWin32Window? owner = null, bool danger = false)
    {
        var list = paths.ToArray();
        using var dialog = new RecycleWindow(title, browser: false, previewRows: list.Length);
        dialog.table.SetRows(list.Select(path => new RecycleRow(
            Guid.Empty, Path.GetFileName(path), Path.GetDirectoryName(path) ?? "", "", path)).ToArray());
        dialog.status.Text = note;
        AddButton(dialog.rightActions, action, primary: true, danger: danger, () => dialog.DialogResult = DialogResult.OK);
        var cancel = AddButton(dialog.rightActions, "Cancel", primary: false, danger: false, () => dialog.DialogResult = DialogResult.Cancel);
        dialog.CancelButton = cancel;
        dialog.Shown += (_, _) => { dialog.Activate(); cancel.Focus(); };
        return dialog.ShowDialog(owner) == DialogResult.OK;
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (browser && keyData == Keys.Escape) { Close(); return true; }
        if (browser && keyData == (Keys.Control | Keys.A)) { table.SelectAll(); return true; }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DeckTheme.Changed -= ApplyTheme;
        base.Dispose(disposing);
    }

    private sealed record RecycleRow(Guid Id, string Name, string Location, string Recycled, string FullPath);

    private sealed class RecycleTable : Control
    {
        private const float HeaderHeight = 26f;
        private const float RowHeight = 28f;
        private const float PadX = 12f;
        private const float ScrollTrackWidth = 14f;
        private const TextFormatFlags TextFlags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
            | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;

        private readonly bool showDate;
        private readonly bool selectable;
        private readonly ThinScrollBar scroll = new();
        private readonly ToolTip tips = new() { InitialDelay = 400, ReshowDelay = 120 };
        private readonly HashSet<int> selected = [];
        private RecycleRow[] rows = [];
        private int anchor = -1;
        private int hover = -1;
        private string? activeTip;

        internal string EmptyText { get; set; } = "";
        internal int RowCount => rows.Length;
        internal int SelectedCount => selected.Count;
        internal event EventHandler? SelectionChanged;
        internal event EventHandler? RowActivated;

        internal RecycleTable(bool showDate, bool selectable)
        {
            this.showDate = showDate;
            this.selectable = selectable;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = selectable;
            BackColor = DeckTheme.Background;
        }

        private float DpiScale => DeviceDpi / 96f;

        internal Guid[] SelectedIds() => selected.Order().Where(i => i >= 0 && i < rows.Length).Select(i => rows[i].Id).ToArray();

        internal void SetRows(RecycleRow[] next)
        {
            rows = next;
            selected.Clear();
            anchor = -1;
            hover = -1;
            scroll.Offset = 0;
            UpdateScroll();
            Invalidate();
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }

        internal void SelectAll()
        {
            if (!selectable || rows.Length == 0) return;
            selected.Clear();
            for (var i = 0; i < rows.Length; i++) selected.Add(i);
            Invalidate();
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }

        internal void ToggleSelectAll()
        {
            if (!selectable || rows.Length == 0) return;
            if (selected.Count == rows.Length) selected.Clear();
            else { selected.Clear(); for (var i = 0; i < rows.Length; i++) selected.Add(i); }
            Invalidate();
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }

        private void UpdateScroll()
        {
            var width = Width / DpiScale;
            var height = Height / DpiScale;
            var viewport = Math.Max(0, height - HeaderHeight - 6);
            scroll.Update(new RectangleF(width - ScrollTrackWidth - 2, HeaderHeight + 3, ScrollTrackWidth, viewport), viewport, rows.Length * RowHeight);
        }

        private int RowAt(PointF logical)
        {
            if (logical.Y < HeaderHeight + 2 || logical.X >= Width / DpiScale - (scroll.Visible ? ScrollTrackWidth + 4 : 2)) return -1;
            var index = (int)((logical.Y - HeaderHeight - 2 + scroll.Offset) / RowHeight);
            return index >= 0 && index < rows.Length ? index : -1;
        }

        protected override void OnResize(EventArgs e) { base.OnResize(e); UpdateScroll(); }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
            var dirty = scroll.OnMouseMove(point);
            if (scroll.Dragging) { if (dirty) Invalidate(); return; }
            var overRow = !scroll.HitTest(point) ? RowAt(point) : -1;
            var next = selectable ? overRow : -1;
            if (next != hover) { hover = next; dirty = true; }
            var tip = overRow >= 0 ? rows[overRow].FullPath : null;
            if (tip != activeTip) { activeTip = tip; tips.SetToolTip(this, tip); }
            Cursor = scroll.HitTest(point) || next >= 0 ? Cursors.Hand : Cursors.Default;
            if (dirty) Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            var dirty = scroll.OnMouseLeave();
            if (hover != -1) { hover = -1; dirty = true; }
            if (activeTip is not null) { activeTip = null; tips.SetToolTip(this, null); }
            Cursor = Cursors.Default;
            if (dirty) Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (selectable) Focus();
            var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
            if (scroll.OnMouseDown(point)) { Capture = true; Invalidate(); return; }
            if (!selectable) return;
            var index = RowAt(point);
            if (index < 0)
            {
                if (selected.Count > 0) { selected.Clear(); Invalidate(); SelectionChanged?.Invoke(this, EventArgs.Empty); }
                return;
            }
            if ((ModifierKeys & Keys.Shift) != 0 && anchor >= 0)
            {
                if ((ModifierKeys & Keys.Control) == 0) selected.Clear();
                var (from, to) = anchor <= index ? (anchor, index) : (index, anchor);
                for (var i = from; i <= to; i++) selected.Add(i);
            }
            else if ((ModifierKeys & Keys.Control) != 0)
            {
                if (!selected.Remove(index)) selected.Add(index);
                anchor = index;
            }
            else
            {
                selected.Clear();
                selected.Add(index);
                anchor = index;
            }
            Invalidate();
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (scroll.OnMouseUp()) { Capture = false; Invalidate(); }
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (!selectable || e.Button != MouseButtons.Left) return;
            var index = RowAt(new PointF(e.X / DpiScale, e.Y / DpiScale));
            if (index >= 0) RowActivated?.Invoke(this, EventArgs.Empty);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            if (scroll.ScrollWheel(e.Delta, RowHeight * 2.5f)) Invalidate();
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
                using var fill = new SolidBrush(DeckTheme.Panel);
                g.FillPath(fill, path);
                using var border = new Pen(DeckTheme.Border, 1);
                g.DrawPath(border, path);
            }

            var contentRight = width - (scroll.Visible ? ScrollTrackWidth + 6 : 8);
            var usable = Math.Max(120, contentRight - PadX);
            float dateW = showDate ? 120 : 0;
            float nameW = MathF.Round((usable - dateW) * (showDate ? 0.36f : 0.40f));
            float locX = PadX + nameW + 10;
            float locW = Math.Max(40, usable - nameW - dateW - (showDate ? 20 : 10));
            float dateX = locX + locW + 10;

            DrawText(g, "NAME", DeckTheme.Label, DeckTheme.Muted, PadX, 1, nameW, HeaderHeight, scale);
            DrawText(g, "ORIGINAL LOCATION", DeckTheme.Label, DeckTheme.Muted, locX, 1, locW, HeaderHeight, scale);
            if (showDate) DrawText(g, "RECYCLED", DeckTheme.Label, DeckTheme.Muted, dateX, 1, dateW, HeaderHeight, scale, TextFormatFlags.Right);
            using (var sep = new Pen(DeckTheme.Border, 1))
                g.DrawLine(sep, 1, HeaderHeight + 0.5f, width - 1, HeaderHeight + 0.5f);

            if (rows.Length == 0)
            {
                g.Restore(saved);
                var body = Rectangle.Round(new RectangleF(0, HeaderHeight * scale, Width, Math.Max(0, Height - HeaderHeight * scale)));
                TextRenderer.DrawText(g, EmptyText, DeckTheme.Caption, body, DeckTheme.Muted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                return;
            }

            var clip = new RectangleF(2, HeaderHeight + 1.5f, width - 4, Math.Max(0, height - HeaderHeight - 3));
            var state = g.Save();
            g.SetClip(clip);
            for (var i = 0; i < rows.Length; i++)
            {
                var rowY = HeaderHeight + 2 + i * RowHeight - scroll.Offset;
                if (rowY + RowHeight < HeaderHeight || rowY > height) continue;

                var isSelected = selected.Contains(i);
                var rowRect = new RectangleF(5, rowY + 1, contentRight - 5, RowHeight - 2);
                if (isSelected)
                {
                    using var selPath = DeckTheme.RoundedRectangle(rowRect, 5);
                    using var selBrush = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Accent, 0.24f));
                    g.FillPath(selBrush, selPath);
                }
                else if (i == hover)
                {
                    using var hovPath = DeckTheme.RoundedRectangle(rowRect, 5);
                    using var hovBrush = new SolidBrush(DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.65f));
                    g.FillPath(hovBrush, hovPath);
                }

                var row = rows[i];
                DrawText(g, row.Name, DeckTheme.Caption, DeckTheme.Text, PadX, rowY, nameW, RowHeight, scale);
                DrawText(g, row.Location, DeckTheme.Small, DeckTheme.Muted, locX, rowY, locW, RowHeight, scale);
                if (showDate) DrawText(g, row.Recycled, DeckTheme.Small, DeckTheme.Muted, dateX, rowY, dateW, RowHeight, scale, TextFormatFlags.Right);
            }
            g.Restore(state);
            scroll.Paint(g);
            g.Restore(saved);
        }

        private static void DrawText(Graphics g, string text, Font font, Color color, float x, float y, float width, float height, float scale, TextFormatFlags align = TextFormatFlags.Left)
        {
            if (text.Length == 0 || width <= 0) return;
            var rect = Rectangle.Round(new RectangleF(x * scale, y * scale, width * scale, height * scale));
            TextRenderer.DrawText(g, text, font, rect, color, TextFlags | align | TextFormatFlags.PreserveGraphicsClipping);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) tips.Dispose();
            base.Dispose(disposing);
        }
    }
}
