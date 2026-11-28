import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'
import { RmDocument } from '../packages/rm-format/src/index'
useCloudMode()
const doc='11111111-1111-4111-a111-111111111111'
const to='/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const url='/api/documents/88888888-8888-4888-a888-888888888888/pages/99999999-9999-4999-a999-999999999999/assets/ab1e0001-0000-4000-a000-0000000000ab.png'
for(const depart of ['stay','depart','failed']) test('native image '+depart,async({page})=>{
 const base='/api/documents/'+doc+'/pages/'+crypto.randomUUID()
 const from=base.replace('/api/documents','/app').replace('/pages','')
 await page.goto(from)
 await expect(page.getByTestId('sync-status')).toHaveText('synced')
 await page.evaluate(async()=>{
  const c=(window as any).__weftController
  await c.createLayer('Drop origin')
  await c.createLayer('Other layer')
  c.setActiveLayer(c.listLayers().find((l:any)=>l.label==='Drop origin').ref)
 })
 const original=await page.evaluateHandle(()=> (window as any).__weftController)
 let commit!: (value:{status:number,url:string})=>void
 const uploaded=new Promise<{status:number,url:string}>(r=>commit=r)
 let release!:()=>void
 const wait=new Promise<void>(r=>release=r)
 await page.route('**'+base+'/assets/*',async route=>{
  if(route.request().method()!=='PUT') return route.continue()
  if(depart==='failed') {
   commit({status:500,url:route.request().url()})
   await wait
   return route.fulfill({status:500}).catch(()=>{})
  }
  const response=await route.fetch()
  commit({status:response.status(),url:response.url()})
  await wait
  await route.fulfill({response}).catch(()=>{})
 })
 const dataTransfer=await page.evaluateHandle(async u=>{
  const blob=await (await fetch(u)).blob()
  const dt=new DataTransfer()
  dt.items.add(new File([blob],'drop.png',{type:'image/png'}))
  return dt
 },url)
 await page.dispatchEvent('.tl-canvas','drop',{dataTransfer})
 try {
  const accepted=await uploaded
  if(depart!=='failed') {
   expect(accepted.status).toBe(200)
   expect((await page.request.get(accepted.url)).status()).toBe(200)
  }
  await original.evaluate((c:any)=>c.setActiveLayer(c.listLayers().find((l:any)=>l.label==='Other layer').ref))
  if(depart!=='stay'){
   await page.evaluate(h=>{ const a=document.createElement('a'); a.href=h; document.body.appendChild(a); a.click() },to)
   await expect(page.getByText('Saving your latest edits')).toBeVisible()
   await expect(page).toHaveURL(new RegExp(from+'$'))
   expect(await original.evaluate((c:any)=>c.disposed)).toBe(false)
  }
 } finally { release() }
 if(depart==='failed') {
  await expect(page.getByText(/latest edits could not be saved/)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(from+'$'))
  await expect(page.locator('.tl-image')).toHaveCount(0)
  // This rejected upload is not a permanently pending edit.
  await page.evaluate(h=>{ const a=document.createElement('a'); a.href=h; document.body.appendChild(a); a.click() },to)
  await expect(page).toHaveURL(new RegExp(to+'$'))
  await expect(page.locator('.tl-image')).toHaveCount(0)
  return
 }
 if(depart==='depart') {
  await expect(page).toHaveURL(new RegExp(to+'$'))
  await expect(page.locator('.tl-image')).toHaveCount(0)
  await page.goto(from)
 }
 await expect(page.getByTestId('sync-status')).toHaveText('synced')
 await expect.poll(async()=>{
  const res=await page.request.get(base+'/rm')
  if(res.status()!==200) return []
  const parsed=RmDocument.parse(new Uint8Array(await res.body()) as never)
  const layers=parsed.layers()
  return parsed.blocks.filter((b:any)=> b.type==='sceneImageItem' && b.deletedLength===0).map((b:any)=>layers.find(l=>l.nodeId.part1===b.parentId.part1 && l.nodeId.part2===b.parentId.part2)?.label)
 }).toEqual(['Drop origin'])
 await expect(page.locator('.tl-image')).toHaveCount(1)
})
