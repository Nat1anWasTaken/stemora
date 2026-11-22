import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all duration-150 ease-spring outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-96 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        toggle: "text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary",
        stem: "text-stem hover:bg-muted aria-pressed:text-muted-foreground",
        cell: "flex-col items-start border-border bg-secondary/60 text-foreground hover:bg-secondary aria-pressed:border-primary/60 aria-pressed:bg-primary/10",
        play: "bg-primary text-primary-foreground glow-primary hover:bg-primary/90",
        link: "text-primary underline-offset-4 hover:underline",
        /* Looks like a search field; opens the command palette */
        search: "justify-start border-border bg-background font-normal text-muted-foreground hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        /* Opens a picker for the input it is joined to (the input uses `attached`) */
        addon: "rounded-l-none border-input border-l-0 text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted dark:bg-input/30",
        /* Pill showing a value that opens its editor (tempo marker on phones) */
        chip: "rounded-full border-border bg-secondary/60 font-semibold tabular-nums text-foreground hover:bg-secondary",
        /* One click of a metronome pattern, drawn as a dot by `data-level`: accent filled, normal a ring, soft a smaller thin ring, muted a faint speck; `data-playing` marks the click sounding now */
        click:
          "rounded-full hover:bg-muted/60 after:block after:rounded-full after:transition-all after:duration-150 after:ease-spring data-[level=accent]:after:bg-primary data-[level=normal]:after:border-[3px] data-[level=normal]:after:border-muted-foreground data-[level=soft]:after:scale-70 data-[level=soft]:after:border-2 data-[level=soft]:after:border-muted-foreground data-[level=muted]:after:scale-40 data-[level=muted]:after:bg-muted-foreground/40 data-playing:after:scale-125 data-playing:after:ring-4 data-playing:after:ring-primary/35 data-[level=normal]:data-playing:after:border-foreground data-[level=soft]:data-playing:after:scale-100 data-[level=soft]:data-playing:after:border-foreground",
      },
      size: {
        default:
          "h-10 gap-2 px-2.5 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 pointer-coarse:h-11 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 pointer-coarse:h-11 rounded-[min(var(--radius-md),12px)] px-3 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-4 text-base has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-10 pointer-coarse:size-11",
        addon: "h-8 w-7 pointer-coarse:h-11 pointer-coarse:w-11",
        cell: "h-14 justify-center gap-0 rounded-2xl px-4",
        "icon-xs":
          "size-6 pointer-coarse:size-11 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-9 pointer-coarse:size-11 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-11 rounded-full active:scale-90",
        "icon-xl": "size-16 rounded-full active:scale-92 [&_svg:not([class*='size-'])]:size-7",
        /* Metronome pattern dot: beats and subdivisions share one size, so only the level tells them apart */
        click: "size-10 pointer-coarse:size-11 after:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  nativeButton,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      render={render}
      // a custom element (e.g. router Link) is not a native <button>
      nativeButton={nativeButton ?? (render === undefined)}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
