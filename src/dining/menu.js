// 金额统一以“分”保存；修改这里即可更换店铺和菜单。
const shop = {
  name: '链家烧烤', subtitle: '人间烟火，串起好滋味。', branch: '堂食 · 自取',
  hours: '待店主补充', address: '门店地址待补充',
  phone: '', packingFee: 0, announcement: '羊肉现穿 · 现点现烤 · 趁热才够味',
  demo: true
};
// 分类与价格依据店主提供的两张纸质菜单；未确认的羊鞭、花生、毛豆暂不录入。
const categories = [
  {
    "id": "popular",
    "name": "招牌推荐",
    "icon": "/assets/icons/signature-muted.png",
    "activeIcon": "/assets/icons/signature-active.png"
  },
  {
    "id": "specialty",
    "name": "特色烧烤",
    "icon": "/assets/icons/flame.png",
    "activeIcon": "/assets/icons/flame-warm.png"
  },
  {
    "id": "skewers",
    "name": "经典烤串",
    "icon": "/assets/icons/skewers-muted.png",
    "activeIcon": "/assets/icons/skewers-active.png"
  },
  {
    "id": "dumplings",
    "name": "水饺主食",
    "icon": "/assets/icons/menu.png",
    "activeIcon": "/assets/icons/menu.png"
  },
  {
    "id": "hot",
    "name": "热菜",
    "icon": "/assets/icons/signature-muted.png",
    "activeIcon": "/assets/icons/signature-active.png"
  }
];
const dishes = [
  {"id": "fresh-lamb-half", "category": "specialty", "name": "羊肉现穿（半斤）", "description": "", "price": 3500, "unit": "份", "image": "/assets/food/fresh-lamb-half.jpg", "tag": "半斤一份", "popular": true, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chicken-feet", "category": "specialty", "name": "鸡爪", "description": "", "price": 400, "unit": "个", "image": "/assets/food/chicken-feet.jpg", "tag": "烧烤好搭档", "popular": true, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "white-kidney", "category": "specialty", "name": "大白腰", "description": "", "price": 2500, "unit": "个", "image": "/assets/food/white-kidney.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "grilled-shrimp", "category": "specialty", "name": "烤虾", "description": "", "price": 300, "unit": "个", "image": "/assets/food/grilled-shrimp.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chicken-wing", "category": "specialty", "name": "翅中", "description": "", "price": 400, "unit": "个", "image": "/assets/food/chicken-wing.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "wing-tips", "category": "specialty", "name": "翅尖", "description": "", "price": 300, "unit": "对", "image": "/assets/food/wing-tips.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "yellow-croaker", "category": "specialty", "name": "黄花鱼", "description": "", "price": 300, "unit": "条", "image": "/assets/food/yellow-croaker.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "large-loin", "category": "specialty", "name": "大腰头", "description": "", "price": 700, "unit": "串", "image": "/assets/food/large-loin.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "small-loin", "category": "specialty", "name": "小腰头", "description": "", "price": 200, "unit": "串", "image": "/assets/food/small-loin.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "large-red-kidney", "category": "specialty", "name": "大红腰", "description": "", "price": 2000, "unit": "个", "image": "/assets/food/large-red-kidney.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "capelin", "category": "specialty", "name": "多春鱼", "description": "", "price": 300, "unit": "条", "image": "/assets/food/capelin.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "lamb-eye", "category": "specialty", "name": "羊眼", "description": "", "price": 400, "unit": "个", "image": "/assets/food/lamb-eye.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "halfbeak", "category": "specialty", "name": "马步鱼", "description": "", "price": 300, "unit": "串", "image": "/assets/food/halfbeak.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "large-lamb-skewer", "category": "specialty", "name": "羊肉大串", "description": "", "price": 300, "unit": "串", "image": "/assets/food/large-lamb-skewer.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "large-pork-skewer", "category": "specialty", "name": "猪肉大串", "description": "", "price": 200, "unit": "串", "image": "/assets/food/large-pork-skewer.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "grilled-tofu", "category": "specialty", "name": "烤豆腐", "description": "", "price": 200, "unit": "串", "image": "/assets/food/grilled-tofu.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "grilled-pepper", "category": "specialty", "name": "烤辣椒", "description": "", "price": 200, "unit": "个", "image": "/assets/food/grilled-pepper.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "lamb-skewer", "category": "skewers", "name": "羊肉串", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/lamb-skewer.jpg", "tag": "人气羊肉串", "popular": true, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "tendon", "category": "skewers", "name": "板筋", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/tendon.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "bone-marrow", "category": "skewers", "name": "骨髓", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/bone-marrow.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "milk-curd", "category": "skewers", "name": "奶渣", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/milk-curd.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "meat-tendon", "category": "skewers", "name": "肉筋", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/meat-tendon.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "small-red-kidney", "category": "skewers", "name": "小红腰", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/small-red-kidney.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "heart-tube", "category": "skewers", "name": "心管", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/heart-tube.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "garlic-meat", "category": "skewers", "name": "蒜瓣肉", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/garlic-meat.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "cartilage", "category": "skewers", "name": "脆骨", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/cartilage.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chopped-whip", "category": "skewers", "name": "碎鞭", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/chopped-whip.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chicken-gizzard", "category": "skewers", "name": "鸡胗", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/chicken-gizzard.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chicken-cartilage", "category": "skewers", "name": "掌中宝", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/chicken-cartilage.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "kidney-skin", "category": "skewers", "name": "腰皮", "description": "", "price": 130, "minQuantity": 10, "unit": "串", "image": "/assets/food/kidney-skin.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]},
  {"id": "chive-dumplings", "category": "dumplings", "name": "韭菜肉馅水饺", "description": "每份25个", "price": 1500, "unit": "份", "image": "/assets/food/chive-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "cabbage-dumplings", "category": "dumplings", "name": "白菜肉馅水饺", "description": "每份25个", "price": 1500, "unit": "份", "image": "/assets/food/cabbage-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "fennel-dumplings", "category": "dumplings", "name": "茴香肉馅水饺", "description": "每份25个", "price": 1500, "unit": "份", "image": "/assets/food/fennel-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "shrimp-dumplings", "category": "dumplings", "name": "虾仁水饺", "description": "", "price": 2300, "unit": "份", "image": "/assets/food/shrimp-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "mackerel-dumplings", "category": "dumplings", "name": "鲅鱼水饺", "description": "", "price": 2300, "unit": "份", "image": "/assets/food/mackerel-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "vegetarian-dumplings", "category": "dumplings", "name": "素三鲜水饺", "description": "", "price": 1500, "unit": "份", "image": "/assets/food/vegetarian-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "pork-scallion-dumplings", "category": "dumplings", "name": "猪肉大葱水饺", "description": "", "price": 1500, "unit": "份", "image": "/assets/food/pork-scallion-dumplings.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["原味"]},
  {"id": "yuanyang-tofu", "category": "hot", "name": "鸳鸯豆腐", "description": "", "price": 1900, "unit": "份", "image": "/assets/food/yuanyang-tofu.jpg", "tag": "", "popular": false, "soldOut": false, "options": ["微辣", "不辣", "中辣", "重辣"]}
];
module.exports = { shop, categories, dishes };
