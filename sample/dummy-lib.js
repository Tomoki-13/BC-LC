// dummy-lib.js
export function calculateTotal(price, taxRate = 0.1) {
    return price + (price * taxRate);
}

export const greetUser = (name, age) => {
    if (age >= 18) return `Hello ${name}`;
    return `Hi ${name}`;
};

// これは内部関数なので抽出されないのが理想
function internalHelper() {
    return true;
}