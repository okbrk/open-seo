import { Button } from "@/client/components/ui/button";

export function GoogleAccountHeader({
  label,
  disabled,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-2 text-xs font-medium text-muted-foreground">
      <span className="min-w-0 break-all">{label}</span>
      {onRemove && (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-destructive"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          Remove account
        </Button>
      )}
    </div>
  );
}
