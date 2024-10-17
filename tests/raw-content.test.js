import fs from 'fs'
import path from 'path'
import { run, html, css } from './util/run'

it('raw content', () => {
  let config = {
    content: [
      {
        raw: html`
          <div class="sr-only"></div>
          <div class="content-center"></div>
          <div class="items-start"></div>
          <div class="items-first-baseline"></div>
          <div class="items-last-baseline"></div>
          <div class="self-end"></div>
          <div class="animate-none"></div>
          <div class="animate-spin"></div>
          <div class="appearance-none"></div>
          <div class="bg-local"></div>
          <div class="bg-clip-border"></div>
          <div class="bg-green-500"></div>
          <div class="bg-gradient-to-r"></div>
          <div class="bg-opacity-20"></div>
          <div class="bg-top"></div>
          <div class="bg-no-repeat"></div>
          <div class="bg-cover"></div>
          <div class="bg-origin-border bg-origin-padding bg-origin-content"></div>
          <div class="border-collapse"></div>
          <div class="border-black"></div>
          <div class="border-opacity-10"></div>
          <div class="rounded-md"></div>
          <div class="border-solid"></div>
          <div class="border"></div>
          <div class="border-2"></div>
          <div class="shadow"></div>
          <div class="shadow-md"></div>
          <div class="shadow-lg"></div>
          <div class="decoration-clone decoration-slice"></div>
          <div class="box-border"></div>
          <div class="clear-left"></div>
          <div class="container"></div>
          <div class="cursor-pointer"></div>
          <div class="hidden inline-grid"></div>
          <div class="divide-gray-200"></div>
          <div class="divide-opacity-50"></div>
          <div class="divide-dotted"></div>
          <div class="divide-x-2 divide-y-4 divide-x-0 divide-y-0"></div>
          <div class="fill-current"></div>
          <div class="flex-1"></div>
          <div class="flex-row-reverse"></div>
          <div class="flex-grow"></div>
          <div class="flex-grow-0"></div>
          <div class="flex-shrink"></div>
          <div class="flex-shrink-0"></div>
          <div class="flex-wrap"></div>
          <div class="float-right"></div>
          <div class="font-sans"></div>
          <div class="text-2xl"></div>
          <div class="antialiased"></div>
          <div class="not-italic"></div>
          <div class="tabular-nums ordinal diagonal-fractions"></div>
          <div class="font-medium"></div>
          <div class="gap-x-2 gap-y-3 gap-4"></div>
          <div class="from-red-300 via-purple-200 to-blue-400"></div>
          <div class="auto-cols-min"></div>
          <div class="grid-flow-row"></div>
          <div class="auto-rows-max"></div>
          <div class="col-span-3"></div>
          <div class="col-start-1"></div>
          <div class="col-end-4"></div>
          <div class="row-span-2"></div>
          <div class="row-start-3"></div>
          <div class="row-end-5"></div>
          <div class="grid-cols-4"></div>
          <div class="grid-rows-3"></div>
          <div class="h-16"></div>
          <div class="inset-0 inset-y-4 inset-x-2 top-6 right-8 bottom-12 left-16"></div>
          <div class="isolate isolation-auto"></div>
          <div class="justify-center"></div>
          <div class="justify-items-end"></div>
          <div class="justify-self-start"></div>
          <div class="tracking-tight"></div>
          <div class="leading-relaxed leading-5"></div>
          <div class="list-inside"></div>
          <div class="list-disc"></div>
          <div class="m-4 my-2 mx-auto mt-0 mr-1 mb-3 ml-4"></div>
          <div class="max-h-screen"></div>
          <div class="max-w-full"></div>
          <div class="min-h-0"></div>
          <div class="min-w-min"></div>
          <div class="object-cover"></div>
          <div class="object-bottom"></div>
          <div class="opacity-90"></div>
          <div class="bg-blend-darken bg-blend-difference"></div>
          <div class="mix-blend-multiply mix-blend-saturation"></div>
          <div class="order-last order-2"></div>
          <div class="overflow-hidden"></div>
          <div class="overscroll-contain"></div>
          <div class="scroll-smooth"></div>
          <div class="p-4 py-2 px-3 pt-1 pr-2 pb-3 pl-4"></div>
          <div class="place-content-start"></div>
          <div class="placeholder-green-300"></div>
          <div class="placeholder-opacity-60"></div>
          <div class="place-items-end"></div>
          <div class="place-self-center"></div>
          <div class="pointer-events-none"></div>
          <div class="absolute"></div>
          <div class="resize-none"></div>
          <div class="ring-white"></div>
          <div class="ring-offset-blue-300"></div>
          <div class="ring-offset-2"></div>
          <div class="ring-opacity-40"></div>
          <div class="ring ring-4"></div>
          <div
            class="filter filter-none blur-md brightness-150 contrast-50 drop-shadow-md grayscale hue-rotate-60 invert saturate-200 sepia"
          ></div>
          <div
            class="backdrop-filter backdrop-filter-none backdrop-blur-lg backdrop-brightness-50 backdrop-contrast-0 backdrop-grayscale backdrop-hue-rotate-90 backdrop-invert backdrop-opacity-75 backdrop-saturate-150 backdrop-sepia"
          ></div>
          <div class="rotate-3"></div>
          <div class="scale-95"></div>
          <div class="skew-y-12 skew-x-12"></div>
          <div class="space-x-4 space-y-3 space-x-reverse space-y-reverse"></div>
          <div class="stroke-current"></div>
          <div class="stroke-2"></div>
          <div class="table-fixed"></div>
          <div class="caption-top"></div>
          <div class="caption-bottom"></div>
          <div class="text-center"></div>
          <div class="text-indigo-500"></div>
          <div class="underline"></div>
          <div class="text-opacity-10"></div>
          <div class="overflow-ellipsis truncate"></div>
          <div class="uppercase"></div>
          <div class="transform transform-gpu"></div>
          <div class="origin-top-right"></div>
          <div class="delay-300"></div>
          <div class="duration-200"></div>
          <div class="transition transition-all"></div>
          <div class="ease-in-out"></div>
          <div class="translate-x-5 -translate-x-4 translate-y-6 -translate-x-3"></div>
          <div class="select-none"></div>
          <div class="align-middle"></div>
          <div class="invisible"></div>
          <div class="collapse"></div>
          <div class="whitespace-nowrap"></div>
          <div class="w-12"></div>
          <div class="break-words"></div>
          <div class="z-30"></div>
        `,
      },
    ],
    corePlugins: { preflight: false },
  }

  let input = css`
    @tailwind components;
    @tailwind utilities;
  `

  return run(input, config).then((result) => {
    expect(result.css).toMatchFormattedCss(
      fs.readFileSync(path.resolve(__dirname, './raw-content.test.css'), 'utf8')
    )
  })
})
