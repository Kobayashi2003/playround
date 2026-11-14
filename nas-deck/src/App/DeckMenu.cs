namespace NasDeck;

/// <summary>A themed context menu whose items are built afresh each time it opens.</summary>
internal sealed class DeckMenu : ContextMenuStrip
{
    private static readonly MenuRenderer SharedRenderer = new();
    private readonly Func<IEnumerable<ToolStripItem>> build;

    internal DeckMenu(Func<IEnumerable<ToolStripItem>> build)
    {
        this.build = build;
        Font = DeckTheme.Menu;
        ShowImageMargin = true;
        ShowCheckMargin = false;
        Renderer = SharedRenderer;
        Opening += (_, args) =>
        {
            Rebuild();
            // A menu that was empty when it was asked to open arrives cancelled.
            args.Cancel = Items.Count == 0;
        };
    }

    private void Rebuild()
    {
        SuspendLayout();
        Clear();
        Items.AddRange(build().ToArray());
        Style(this, Items);
        ResumeLayout();
    }

    private void Clear()
    {
        foreach (var item in Items.Cast<ToolStripItem>().ToArray())
        {
            Release(item);
            item.Dispose();
        }
        Items.Clear();

        static void Release(ToolStripItem item)
        {
            item.Image?.Dispose();
            if (item is ToolStripMenuItem menu)
                foreach (ToolStripItem child in menu.DropDownItems) Release(child);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Clear();
        base.Dispose(disposing);
    }

    private void Style(ToolStripDropDown menu, ToolStripItemCollection items)
    {
        int Scale(int value) => DeckTheme.Scale(value, DeviceDpi);

        menu.BackColor = DeckTheme.Panel;
        menu.ForeColor = DeckTheme.Text;
        menu.Font = DeckTheme.Menu;
        menu.Renderer = SharedRenderer;
        menu.Padding = new Padding(Scale(4));
        menu.ImageScalingSize = new Size(Scale(16), Scale(16));
        foreach (ToolStripItem item in items)
        {
            switch (item)
            {
                case ToolStripLabel label:
                    label.Padding = new Padding(Scale(4), Scale(3), Scale(12), Scale(1));
                    break;
                case ToolStripMenuItem entry:
                    entry.Padding = new Padding(Scale(2), Scale(4), Scale(6), Scale(4));
                    entry.ForeColor = DeckTheme.Text;
                    if (entry.Tag is DeckGlyph glyph) entry.Image = DeckIcons.Create(glyph, Scale(16));
                    if (entry.HasDropDownItems) Style(entry.DropDown, entry.DropDownItems);
                    break;
            }
        }
    }

    internal static ToolStripMenuItem Item(string text, DeckGlyph? glyph, Action click, bool enabled = true, bool isChecked = false, string? hint = null)
    {
        var item = new ToolStripMenuItem(text) { Enabled = enabled, ShortcutKeyDisplayString = hint, Tag = isChecked ? DeckGlyph.Check : glyph };
        item.Click += (_, _) => click();
        return item;
    }

    internal static ToolStripMenuItem Sub(string text, DeckGlyph? glyph, IEnumerable<ToolStripItem> children, bool enabled = true)
    {
        var item = new ToolStripMenuItem(text) { Tag = glyph, Enabled = enabled };
        item.DropDownItems.AddRange(children.ToArray());
        return item;
    }

    internal static ToolStripLabel Label(string text, Color? color = null, bool strong = false) =>
        new(text) { Font = strong ? DeckTheme.MenuStrong : DeckTheme.Small, ForeColor = color ?? DeckTheme.Muted };

    internal static ToolStripSeparator Separator() => new();

    private sealed class MenuRenderer() : ToolStripProfessionalRenderer(new MenuColors())
    {
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;
            var inset = DeckTheme.Scale(2, e.ToolStrip?.DeviceDpi ?? 96);
            var bounds = new RectangleF(inset, 1, e.Item.Width - inset * 2, e.Item.Height - 2);
            using var shape = DeckTheme.RoundedRectangle(bounds, inset * 2);
            using var fill = new SolidBrush(DeckTheme.Border);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            e.Graphics.FillPath(fill, shape);
        }

        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

        // WinForms places a menu item's image and its text by different rules, which left the icons sitting
        // a few pixels below the text; both are centred on the item's middle instead.
        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
        {
            if (e.Image is null) return;
            var image = e.ImageRectangle;
            image.Y = (e.Item.Height - image.Height) / 2;
            base.OnRenderItemImage(new ToolStripItemImageRenderEventArgs(e.Graphics, e.Item, e.Image, image));
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            if (e.Item is ToolStripMenuItem)
            {
                e.TextRectangle = new Rectangle(e.TextRectangle.X, 0, e.TextRectangle.Width, e.Item.Height);
                e.TextFormat = (e.TextFormat & ~(TextFormatFlags.Top | TextFormatFlags.Bottom)) | TextFormatFlags.VerticalCenter;
            }
            if (e.Item is ToolStripLabel) e.TextColor = e.Item.ForeColor;
            else if (!e.Item.Enabled)
                e.TextColor = DeckTheme.Mix(DeckTheme.Muted, DeckTheme.Panel, 0.35f);
            else if (e.Item is ToolStripMenuItem menu && e.Text == menu.ShortcutKeyDisplayString)
                e.TextColor = DeckTheme.Muted;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = e.Item?.Enabled == false ? DeckTheme.Border : DeckTheme.Muted;
            base.OnRenderArrow(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using var line = new Pen(DeckTheme.Border);
            var inset = DeckTheme.Scale(8, e.ToolStrip?.DeviceDpi ?? 96);
            e.Graphics.DrawLine(line, inset, e.Item.Height / 2, e.Item.Width - inset, e.Item.Height / 2);
        }
    }

    private sealed class MenuColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => DeckTheme.Panel;
        public override Color ImageMarginGradientBegin => DeckTheme.Panel;
        public override Color ImageMarginGradientMiddle => DeckTheme.Panel;
        public override Color ImageMarginGradientEnd => DeckTheme.Panel;
        public override Color MenuBorder => DeckTheme.Border;
    }
}
