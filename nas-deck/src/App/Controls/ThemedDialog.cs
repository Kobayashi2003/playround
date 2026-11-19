namespace NasDeck;

/// <summary>Compact theme-aware confirmation dialog matching the rest of NAS Deck.</summary>
internal static class ThemedDialog
{
    internal static bool Confirm(IWin32Window? owner, string title, string message, string confirmLabel = "Continue", bool danger = false)
    {
        using var dialog = new Form
        {
            Text = title,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = owner is null ? FormStartPosition.CenterScreen : FormStartPosition.CenterParent,
            ShowInTaskbar = false,
            MinimizeBox = false,
            MaximizeBox = false,
            AutoScaleDimensions = new SizeF(96, 96),
            AutoScaleMode = AutoScaleMode.Dpi,
            BackColor = DeckTheme.Background,
            ForeColor = DeckTheme.Text,
            Font = DeckTheme.Caption,
            ClientSize = new Size(400, 156)
        };
        DeckTheme.Attach(dialog);

        var textHeight = Math.Max(40, TextRenderer.MeasureText(message, DeckTheme.Caption, new Size(360, 400), TextFormatFlags.WordBreak).Height + 8);
        dialog.ClientSize = new Size(400, Math.Clamp(textHeight + 96, 144, 320));

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(20, 16, 20, 16) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 16));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));

        var body = new Label { Text = message, Dock = DockStyle.Fill, Font = DeckTheme.Caption, ForeColor = DeckTheme.Text, Margin = Padding.Empty };
        var divider = DeckTheme.CreateDivider();
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = Padding.Empty };
        var okW = Math.Max(92, TextRenderer.MeasureText(confirmLabel, DeckTheme.Strong).Width + 28);
        var ok = new SurfaceButton { Text = confirmLabel, Size = new Size(okW, 34), Font = DeckTheme.Strong, Danger = danger, Margin = Padding.Empty, DialogResult = DialogResult.OK };
        var cancel = new SurfaceButton { Text = "Cancel", Size = new Size(78, 34), Font = DeckTheme.Caption, Margin = new Padding(0, 0, 8, 0), DialogResult = DialogResult.Cancel };
        DeckTheme.StyleButton(ok, true);
        DeckTheme.StyleButton(cancel);
        actions.Controls.AddRange([ok, cancel]);
        layout.Controls.Add(body, 0, 0);
        layout.Controls.Add(divider, 0, 1);
        layout.Controls.Add(actions, 0, 2);
        dialog.Controls.Add(layout);
        dialog.AcceptButton = ok;
        dialog.CancelButton = cancel;
        dialog.Shown += (_, _) => cancel.Focus();
        return dialog.ShowDialog(owner) == DialogResult.OK;
    }
}
