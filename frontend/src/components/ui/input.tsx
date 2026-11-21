import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const inputVariants = cva(
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "",
        /* Short numeric value (BPM, time signature): centred figures that shake when rejected */
        value: "text-center font-semibold tabular-nums aria-invalid:animate-shake",
      },
      inputSize: {
        default: "",
        lg: "h-11 text-lg md:text-lg",
      },
      /* Joined to a button on its right (the button uses the `addon` variant) */
      attached: {
        false: "",
        true: "rounded-r-none",
      },
    },
    defaultVariants: { variant: "default", inputSize: "default", attached: false },
  }
)

function Input({ className, type, variant, inputSize, attached, ...props }: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant, inputSize, attached }), className)}
      {...props}
    />
  )
}

export { Input }
